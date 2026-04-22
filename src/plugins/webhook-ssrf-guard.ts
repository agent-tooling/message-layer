import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";

/**
 * SSRF guard for outbound webhook deliveries.
 *
 * The webhook plugin fetches user-configurable URLs every time a matching
 * domain event fires. Without a guard, any actor that holds
 * `webhook:subscribe` can point deliveries at cloud-metadata endpoints
 * (`169.254.169.254`), internal infrastructure on RFC1918 ranges, or
 * loopback services sharing the host with message-layer — and, because
 * the plugin records `response_body` on each delivery, read the response
 * back through the subscription listing. That turns "subscribe to webhook"
 * into "read arbitrary internal HTTP".
 *
 * This module classifies a URL or IP as routable vs. blocked using the
 * IANA special-purpose address registries. The defaults block the entire
 * class of private / link-local / loopback / unspecified addresses for
 * both IPv4 and IPv6. Deployments that really need to hit internal
 * endpoints opt in explicitly via `allowPrivateNetworks: true` on the
 * webhook plugin.
 */

export type WebhookEndpointCheckOptions = {
  /** When true, disables the SSRF guard entirely. Default: false. */
  allowPrivateNetworks?: boolean;
  /**
   * Injection point for tests: override the DNS resolver used when the URL
   * host is a hostname rather than an IP literal. Production code should
   * leave this unset so the system resolver (respecting `/etc/hosts`,
   * DNS-over-HTTPS, etc.) is used.
   */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
};

export class BlockedEndpointError extends Error {
  public readonly code = "WEBHOOK_ENDPOINT_BLOCKED";
  public readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "BlockedEndpointError";
    this.reason = reason;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Hostnames that must never be dialled regardless of whether DNS would
 * currently resolve them to a public address. Catches the case where an
 * attacker relies on `/etc/hosts` or a local DNS server overriding a
 * normally-public name, and short-circuits the obvious loopback label.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

function parseIpv4(address: string): [number, number, number, number] | null {
  if (!isIPv4(address)) return null;
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

/**
 * Returns a human-readable reason string if `address` is in any blocked
 * range, or `null` when the address is globally routable.
 *
 * Covers:
 *  - unspecified      `0.0.0.0/8`, `::/128`
 *  - loopback         `127.0.0.0/8`, `::1/128`
 *  - private-use      `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 *  - shared address   `100.64.0.0/10` (CGNAT)
 *  - link-local       `169.254.0.0/16`, `fe80::/10`
 *  - unique-local v6  `fc00::/7`
 *  - discard-prefix   `100::/64`
 *  - documentation    `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`
 *  - benchmarking     `198.18.0.0/15`, `2001:2::/48`
 *  - reserved         `240.0.0.0/4`, `ff00::/8` (IPv6 multicast)
 *  - IPv4-mapped v6   unwrapped and re-checked against the IPv4 list so
 *                     `::ffff:127.0.0.1` is rejected as loopback
 */
export function classifyBlockedIp(address: string): string | null {
  if (isIPv4(address)) {
    const parts = parseIpv4(address);
    if (!parts) return "invalid-ip";
    const [a, b] = parts;
    if (a === 0) return "unspecified";
    if (a === 10) return "private-use";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a === 172 && b >= 16 && b <= 31) return "private-use";
    if (a === 192 && b === 168) return "private-use";
    if (a === 100 && b >= 64 && b <= 127) return "shared-address";
    if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
    if (a === 192 && b === 0 && parts[2] === 2) return "documentation";
    if (a === 198 && b === 51 && parts[2] === 100) return "documentation";
    if (a === 203 && b === 0 && parts[2] === 113) return "documentation";
    if (a >= 224 && a <= 239) return "multicast";
    if (a >= 240) return "reserved";
    if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) {
      return "broadcast";
    }
    return null;
  }

  if (isIPv6(address)) {
    const normalized = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible — re-check as v4.
    const v4MappedMatch = /^::ffff:([0-9.]+)$/.exec(normalized);
    if (v4MappedMatch) {
      return classifyBlockedIp(v4MappedMatch[1]!);
    }
    if (normalized === "::" || normalized === "::0") return "unspecified";
    if (normalized === "::1") return "loopback";
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
        normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return "link-local";
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return "unique-local";
    }
    if (normalized.startsWith("ff")) return "multicast";
    if (normalized.startsWith("2001:db8:") || normalized === "2001:db8::") {
      return "documentation";
    }
    if (normalized.startsWith("2001:2:")) return "benchmarking";
    if (normalized.startsWith("100::")) return "discard";
    return null;
  }

  return "invalid-ip";
}

/**
 * Validates a webhook endpoint. Throws `BlockedEndpointError` with a
 * machine-readable `reason` when any of these hold:
 *   - URL is malformed
 *   - protocol is not http(s)
 *   - host is a blocked hostname (`localhost` et al.)
 *   - host is an IP literal in a blocked range
 *   - host is a hostname that resolves to one or more blocked IPs
 *
 * When `allowPrivateNetworks` is true the guard is a pure no-op, preserving
 * the ability to use this plugin for in-cluster service-to-service hooks.
 */
export async function assertWebhookEndpointSafe(
  endpoint: string,
  options: WebhookEndpointCheckOptions = {},
): Promise<void> {
  if (options.allowPrivateNetworks) return;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BlockedEndpointError("invalid-url", `endpoint is not a valid URL: ${endpoint}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedEndpointError(
      "protocol",
      `endpoint protocol ${url.protocol} is not allowed (only http, https)`,
    );
  }

  // `new URL` wraps IPv6 literals in brackets — strip them for classification.
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;

  if (!hostname) {
    throw new BlockedEndpointError("invalid-url", "endpoint has no host");
  }

  const lowerHost = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lowerHost) || lowerHost.endsWith(".localhost")) {
    throw new BlockedEndpointError(
      "blocked-hostname",
      `endpoint hostname ${hostname} resolves to loopback`,
    );
  }

  if (isIP(hostname)) {
    const reason = classifyBlockedIp(hostname);
    if (reason) {
      throw new BlockedEndpointError(
        reason,
        `endpoint IP ${hostname} is in a blocked range (${reason})`,
      );
    }
    return;
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    // Fail closed: if we cannot verify the destination, refuse to
    // dispatch. A misconfigured / unreachable hostname would not have
    // delivered anyway, so this is consistent with normal operation.
    throw new BlockedEndpointError(
      "unresolvable",
      `failed to resolve endpoint hostname ${hostname}: ${(error as Error).message}`,
    );
  }

  if (addresses.length === 0) {
    throw new BlockedEndpointError(
      "unresolvable",
      `hostname ${hostname} has no DNS records`,
    );
  }

  for (const addr of addresses) {
    const reason = classifyBlockedIp(addr.address);
    if (reason) {
      throw new BlockedEndpointError(
        reason,
        `endpoint ${hostname} resolves to ${addr.address} which is in a blocked range (${reason})`,
      );
    }
  }
}

async function defaultLookup(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  // Node's `Family` type is `number` (4 | 6). Narrow it here so downstream
  // consumers don't have to re-assert.
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}
