import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginSchemas, applyPluginsToApp } from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import { webhookPlugin } from "../../src/plugins/webhooks.js";
import {
  assertWebhookEndpointSafe,
  BlockedEndpointError,
  classifyBlockedIp,
} from "../../src/plugins/webhook-ssrf-guard.js";
import type { Principal } from "../../src/types.js";
import type { ServerPlugin } from "../../src/plugins.js";

/**
 * Regression tests for the webhook-plugin SSRF guard.
 *
 * The guard rejects outbound deliveries to loopback, RFC1918, link-local,
 * shared-CGNAT, documentation, multicast, and unique-local addresses by
 * default. Deployments that genuinely need in-cluster service-to-service
 * hooks flip `allowPrivateNetworks: true`.
 */

// ── pure classification unit tests ─────────────────────────────────────────

describe("classifyBlockedIp", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private-use"],
    ["172.16.0.1", "private-use"],
    ["172.31.255.254", "private-use"],
    ["192.168.1.1", "private-use"],
    ["169.254.169.254", "link-local"], // AWS IMDS, GCP metadata
    ["100.64.0.1", "shared-address"], // CGNAT
    ["0.0.0.0", "unspecified"],
    ["198.18.5.5", "benchmarking"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["::ffff:127.0.0.1", "loopback"], // IPv4-mapped loopback
    ["::ffff:10.0.0.1", "private-use"],
  ];

  for (const [ip, reason] of blocked) {
    test(`blocks ${ip} as ${reason}`, () => {
      expect(classifyBlockedIp(ip)).toBe(reason);
    });
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34", // example.com
    "2606:4700:4700::1111", // Cloudflare
    "2001:4860:4860::8888", // Google DNS
  ];

  for (const ip of allowed) {
    test(`allows globally-routable ${ip}`, () => {
      expect(classifyBlockedIp(ip)).toBeNull();
    });
  }
});

// ── assertWebhookEndpointSafe with injected lookup ─────────────────────────

describe("assertWebhookEndpointSafe", () => {
  test("accepts a globally-routable hostname", async () => {
    await assertWebhookEndpointSafe("https://example.com/hook", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
  });

  test("rejects IP-literal URLs in blocked ranges", async () => {
    const cases = [
      "http://127.0.0.1/hook",
      "http://10.0.0.1/hook",
      "http://192.168.1.1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/hook",
      "http://[fe80::1]/hook",
    ];
    for (const url of cases) {
      await expect(assertWebhookEndpointSafe(url)).rejects.toBeInstanceOf(BlockedEndpointError);
    }
  });

  test("rejects loopback-labelled hostnames without hitting DNS", async () => {
    let dnsHits = 0;
    const err = await assertWebhookEndpointSafe("https://localhost/hook", {
      lookup: async () => {
        dnsHits += 1;
        return [{ address: "1.1.1.1", family: 4 }];
      },
    }).then(
      () => null,
      (e) => e as BlockedEndpointError,
    );
    expect(err).toBeInstanceOf(BlockedEndpointError);
    expect(err?.reason).toBe("blocked-hostname");
    expect(dnsHits).toBe(0);
  });

  test("rejects *.localhost too", async () => {
    await expect(
      assertWebhookEndpointSafe("https://svc.localhost/hook"),
    ).rejects.toBeInstanceOf(BlockedEndpointError);
  });

  test("rejects non-http(s) schemes", async () => {
    await expect(
      assertWebhookEndpointSafe("file:///etc/passwd"),
    ).rejects.toBeInstanceOf(BlockedEndpointError);
    await expect(
      assertWebhookEndpointSafe("gopher://internal/"),
    ).rejects.toBeInstanceOf(BlockedEndpointError);
  });

  test("rejects hostnames that resolve to a private IP (DNS-pinning)", async () => {
    const err = await assertWebhookEndpointSafe("https://sneaky.example/hook", {
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
    }).then(
      () => null,
      (e) => e as BlockedEndpointError,
    );
    expect(err).toBeInstanceOf(BlockedEndpointError);
    expect(err?.reason).toBe("private-use");
  });

  test("rejects when ANY resolved address is blocked", async () => {
    // Some DNS setups return both v4 and v6 answers. If either is internal
    // we must refuse — otherwise an attacker could force the connection to
    // happen-family-select their way to the private address.
    const err = await assertWebhookEndpointSafe("https://mixed.example/hook", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "fe80::1", family: 6 },
      ],
    }).then(
      () => null,
      (e) => e as BlockedEndpointError,
    );
    expect(err).toBeInstanceOf(BlockedEndpointError);
    expect(err?.reason).toBe("link-local");
  });

  test("fails closed on DNS resolution errors", async () => {
    const err = await assertWebhookEndpointSafe("https://nx.example/hook", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    }).then(
      () => null,
      (e) => e as BlockedEndpointError,
    );
    expect(err).toBeInstanceOf(BlockedEndpointError);
    expect(err?.reason).toBe("unresolvable");
  });

  test("allowPrivateNetworks=true disables the guard entirely", async () => {
    await assertWebhookEndpointSafe("http://127.0.0.1/hook", {
      allowPrivateNetworks: true,
    });
    await assertWebhookEndpointSafe("http://169.254.169.254/meta", {
      allowPrivateNetworks: true,
    });
    await assertWebhookEndpointSafe("http://localhost/hook", {
      allowPrivateNetworks: true,
    });
  });
});

// ── integration: HTTP surface rejects blocked subscriptions ────────────────

type Harness = {
  db: SqlDatabase;
  service: MessageLayer;
  bus: InProcessEventBus;
  app: ReturnType<typeof createApp>;
  dispose: () => Promise<void>;
  close: () => Promise<void>;
};

async function makeHarness(plugin: ServerPlugin): Promise<Harness> {
  const db = await connect(`memory://ssrf-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  await applyPluginSchemas(db, [plugin]);
  const dispose = await applyPluginsToApp(
    {
      app,
      db,
      service,
      bus,
      logger: () => {},
      env: {},
      config: { port: 0, storage: { adapter: "pglite", path: "memory://ssrf" }, plugins: [] },
    },
    [plugin],
  );
  return {
    db,
    service,
    bus,
    app,
    dispose,
    close: async () => {
      await dispose();
      await db.close?.();
    },
  };
}

describe("webhooks plugin — SSRF-guarded subscription creation", () => {
  let harness: Harness;
  let principal: Principal;

  async function bootstrap(): Promise<void> {
    const orgId = await harness.service.createOrg("ssrf");
    const actorId = await harness.service.createActor(orgId, "human", "admin");
    principal = {
      actorId,
      orgId,
      scopes: ["webhook:subscribe", "webhook:read"],
      provider: "test",
    };
  }

  afterEach(async () => {
    await harness?.close();
  });

  test("default: POST with a loopback endpoint returns 400 WEBHOOK_ENDPOINT_BLOCKED", async () => {
    // Inject a deterministic resolver so we don't depend on external DNS
    // in CI and so the test shape is identical to production logic.
    harness = await makeHarness(
      webhookPlugin({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }),
    );
    await bootstrap();
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "http://127.0.0.1/sink",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("WEBHOOK_ENDPOINT_BLOCKED");
    expect(body.reason).toBe("loopback");
  });

  test("default: POST with cloud-metadata IP is blocked", async () => {
    harness = await makeHarness(webhookPlugin());
    await bootstrap();
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "http://169.254.169.254/latest/meta-data/iam/",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.reason).toBe("link-local");
  });

  test("default: POST with hostname that resolves to private IP is blocked", async () => {
    harness = await makeHarness(
      webhookPlugin({ lookup: async () => [{ address: "10.1.2.3", family: 4 }] }),
    );
    await bootstrap();
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "https://internal.corp/hook",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.reason).toBe("private-use");
  });

  test("default: public hostname is accepted", async () => {
    harness = await makeHarness(
      webhookPlugin({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }),
    );
    await bootstrap();
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "https://example.com/hook",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("allowPrivateNetworks: true lets loopback through", async () => {
    harness = await makeHarness(webhookPlugin({ allowPrivateNetworks: true }));
    await bootstrap();
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "http://127.0.0.1:9000/hook",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ── integration: delivery-time re-check catches DNS-rebinding ──────────────
//
// Simulates "the subscription was created when the host looked public, but
// the next time it's resolved, it resolves to an RFC1918 address." The
// plugin's per-delivery `assertWebhookEndpointSafe` catches that and the
// HTTP call never happens. We prove this by swapping `globalThis.fetch`
// with a spy that fails loudly if it is ever invoked for a blocked URL.

describe("webhooks plugin — delivery-time SSRF re-check", () => {
  let harness: Harness;
  let principal: Principal;
  let channelId: string;

  afterEach(async () => {
    await harness?.close();
  });

  test("blocks delivery when DNS flips to a private IP after subscription", async () => {
    // Start with a resolver that returns a public IP so subscription creation
    // succeeds. Then flip it to a private IP and append a message — the
    // event bus will attempt to deliver, hit the guard, and record an error
    // delivery row instead of calling fetch.
    let currentAddress = "93.184.216.34";
    const fakeLookup = async () => [{ address: currentAddress, family: 4 as const }];

    harness = await makeHarness(webhookPlugin({ lookup: fakeLookup }));

    const orgId = await harness.service.createOrg("rebind");
    const actorId = await harness.service.createActor(orgId, "human", "admin");
    principal = {
      actorId,
      orgId,
      scopes: [
        "channel:create",
        "message:append",
        "webhook:subscribe",
        "webhook:read",
      ],
      provider: "test",
    };
    channelId = await harness.service.createChannel(principal, "general", "public");

    const create = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({
          endpoint: "https://attacker.example/hook",
          eventTypes: ["message.appended"],
          streamId: channelId,
        }),
      }),
    );
    expect(create.status).toBe(200);

    // Flip DNS to a blocked address before appending.
    currentAddress = "10.0.0.5";

    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(typeof input === "string" ? input : (input as { url: string }).url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await harness.service.appendMessage(principal, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "trigger" } }],
        idempotencyKey: "ssrf-rebind-1",
      });
      // Let the async delivery microtask run.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toEqual([]);

    const deliveryRows = await harness.db.query<{
      status_code: number | null;
      success: number;
      error_message: string | null;
    }>(
      "SELECT status_code, success, error_message FROM webhook_deliveries WHERE org_id=?",
      [orgId],
    );
    expect(deliveryRows.rows.length).toBe(1);
    const row = deliveryRows.rows[0]!;
    expect(row.success).toBe(0);
    expect(row.status_code).toBeNull();
    expect(row.error_message).toContain("WEBHOOK_ENDPOINT_BLOCKED");
    expect(row.error_message).toContain("private-use");
  });
});
