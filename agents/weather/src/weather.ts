import { bootstrapAgent } from "./bootstrap.js";
import { MessageLayerClient } from "./ml.js";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const INTERVAL_MS = Number(args.intervalMs ?? process.env.WEATHER_INTERVAL_MS ?? "10000");
const ONCE = args.once;

type WeatherArgs = {
  city: string;
  unit: "c" | "f";
};

type WeatherSnapshot = {
  city: string;
  unit: "c" | "f";
  temperature: number;
  feelsLike: number;
  condition: "sunny" | "cloudy" | "rain" | "storm" | "windy";
  humidity: number;
  windKph: number;
  chanceOfRain: number;
  updatedAtIso: string;
};

async function isNextjsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HEALTH_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (args.help) {
    printUsage();
    return;
  }
  if (!ORG_ID) {
    throw new Error("missing org id. Pass --org-id <id> or set MESSAGE_LAYER_ORG_ID.");
  }
  if (!(await isNextjsUp())) {
    throw new Error(`Next.js at ${HEALTH_URL} is not responding`);
  }

  const { principal, reused } = await bootstrapAgent({
    baseUrl: BASE_URL,
    appUrl: HEALTH_URL,
    orgId: ORG_ID,
    displayName: "weather-agent",
  });
  console.log(
    `[weather] ${reused ? "reusing" : "created"} actor ${principal.actorId} in org ${principal.orgId}`,
  );
  const scopedClient = new MessageLayerClient(BASE_URL, principal);

  const commandRegistration = await scopedClient.registerCommand({
    name: "weather-check",
    description: "Generate a weather card UI in a thread.",
    argsSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name (optional)." },
        unit: { type: "string", enum: ["c", "f"], description: "Temperature unit." },
      },
    },
  });
  if (commandRegistration.ok) {
    console.log(
      `[weather] registered /weather-check (commandId=${commandRegistration.commandId}, request=${commandRegistration.requestId})`,
    );
  } else {
    console.log(`[weather] could not register /weather-check yet: ${commandRegistration.message}`);
  }

  const lastSeqByChannel = new Map<string, number>();
  const seenInvocationKeys = new Set<string>();

  for (;;) {
    if (!(await isNextjsUp())) {
      console.log(`[weather] Next.js health check failed; stopping loop`);
      break;
    }

    try {
      const channels = await scopedClient.listChannels();
      for (const channel of channels) {
        const fromSeq = lastSeqByChannel.get(channel.id) ?? 0;
        const events = await scopedClient.listStreamEvents(channel.id, fromSeq);
        let maxSeq = fromSeq;
        for (const event of events) {
          if (typeof event.streamSeq === "number") maxSeq = Math.max(maxSeq, event.streamSeq);
          if (event.type !== "command.invoked") continue;
          const command = typeof event.payload.command === "string" ? event.payload.command : "";
          if (!isWeatherCommand(command)) continue;
          const ownerActorId = typeof event.payload.ownerActorId === "string" ? event.payload.ownerActorId : null;
          if (ownerActorId && ownerActorId !== principal.actorId) continue;

          const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
          const partIndex = typeof event.payload.partIndex === "number" ? event.payload.partIndex : -1;
          const streamType = event.payload.streamType === "thread" ? "thread" : "channel";
          const streamId = typeof event.payload.streamId === "string" ? event.payload.streamId : channel.id;
          if (!messageId || partIndex < 0) continue;

          const key = `${messageId}:${partIndex}`;
          if (seenInvocationKeys.has(key)) continue;
          seenInvocationKeys.add(key);

          const parsedArgs = await resolveWeatherArgs({
            client: scopedClient,
            streamId,
            messageId,
            streamSeq:
              typeof event.payload.streamSeq === "number" ? event.payload.streamSeq : event.streamSeq ?? 0,
            partIndex,
          });
          const snapshot = buildWeatherSnapshot(parsedArgs);

          const result = await postWeatherReply({
            client: scopedClient,
            streamType,
            channelId: channel.id,
            parentMessageId: messageId,
            targetThreadId: streamType === "thread" ? streamId : null,
            snapshot,
          });
          if (result.ok) {
            console.log(`[weather] replied to /${command} with weather card (message ${result.messageId})`);
          } else {
            console.log(
              `[weather] could not reply to /${command}: ${result.message}${result.requestId ? ` request=${result.requestId}` : ""}`,
            );
          }
        }
        lastSeqByChannel.set(channel.id, maxSeq);
      }
    } catch (error) {
      console.error(`[weather] ${error instanceof Error ? error.message : String(error)}`);
    }

    if (ONCE) break;
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWeatherCommand(command: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return lower === "weather-check" || lower.endsWith(":weather-check");
}

async function resolveWeatherArgs(input: {
  client: MessageLayerClient;
  streamId: string;
  messageId: string;
  streamSeq: number;
  partIndex: number;
}): Promise<WeatherArgs> {
  const fallback: WeatherArgs = { city: "San Francisco", unit: "c" };
  const messages = await input.client.listMessages(input.streamId, Math.max(0, input.streamSeq - 1));
  const message = messages.find((m) => m.id === input.messageId);
  if (!message) return fallback;
  const commandPart = message.parts[input.partIndex];
  if (!commandPart || commandPart.type !== "command") return fallback;
  const args = commandPart.payload.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return fallback;

  const candidateCity = typeof (args as { city?: unknown }).city === "string" ? (args as { city: string }).city : "";
  const candidateUnit = typeof (args as { unit?: unknown }).unit === "string" ? (args as { unit: string }).unit : "";
  const city = candidateCity.trim().length > 0 ? candidateCity.trim() : fallback.city;
  const unit: "c" | "f" = candidateUnit.toLowerCase() === "f" ? "f" : "c";
  return { city, unit };
}

function buildWeatherSnapshot(input: WeatherArgs): WeatherSnapshot {
  const seed = `${input.city.toLowerCase()}:${new Date().toISOString().slice(0, 13)}`;
  const conditionPool: Array<WeatherSnapshot["condition"]> = ["sunny", "cloudy", "rain", "storm", "windy"];
  const condition = conditionPool[hash(seed + ":condition") % conditionPool.length];
  const tempBase = randomInRange(seed + ":temp", input.unit === "c" ? 8 : 45, input.unit === "c" ? 32 : 95);
  const feelsOffset = randomInRange(seed + ":feels", -3, 3);

  return {
    city: input.city,
    unit: input.unit,
    temperature: tempBase,
    feelsLike: tempBase + feelsOffset,
    condition,
    humidity: randomInRange(seed + ":humidity", 30, 88),
    windKph: randomInRange(seed + ":wind", 4, 42),
    chanceOfRain: randomInRange(seed + ":rain", 5, 95),
    updatedAtIso: new Date().toISOString(),
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h >>> 0);
}

function randomInRange(seed: string, min: number, max: number): number {
  const span = max - min + 1;
  return min + (hash(seed) % span);
}

function conditionLabel(condition: WeatherSnapshot["condition"]): string {
  switch (condition) {
    case "sunny":
      return "Sunny";
    case "cloudy":
      return "Cloudy";
    case "rain":
      return "Rain";
    case "storm":
      return "Storm";
    case "windy":
      return "Windy";
    default:
      return "Unknown";
  }
}

function conditionVariant(
  condition: WeatherSnapshot["condition"],
): "default" | "success" | "warning" | "error" | "info" {
  switch (condition) {
    case "sunny":
      return "success";
    case "cloudy":
      return "info";
    case "rain":
      return "warning";
    case "storm":
      return "error";
    case "windy":
      return "default";
    default:
      return "default";
  }
}

function createWeatherUiSpec(snapshot: WeatherSnapshot): Record<string, unknown> {
  const unitSuffix = snapshot.unit === "c" ? "C" : "F";
  const condition = conditionLabel(snapshot.condition);
  return {
    root: "weather-card",
    elements: {
      "weather-card": {
        type: "Card",
        props: {
          title: `Weather in ${snapshot.city}`,
          description: `Updated ${new Date(snapshot.updatedAtIso).toLocaleTimeString()}`,
        },
        children: ["weather-stack"],
      },
      "weather-stack": {
        type: "Stack",
        props: { direction: "vertical", gap: 3 },
        children: ["current-row", "metrics-row", "weather-alert"],
      },
      "current-row": {
        type: "Stack",
        props: { direction: "horizontal", gap: 3, wrap: true },
        children: ["temp-metric", "condition-badge"],
      },
      "temp-metric": {
        type: "Metric",
        props: {
          label: "Current",
          value: `${snapshot.temperature}°${unitSuffix}`,
          description: `Feels like ${snapshot.feelsLike}°${unitSuffix}`,
        },
        children: [],
      },
      "condition-badge": {
        type: "Badge",
        props: {
          text: condition,
          variant: conditionVariant(snapshot.condition),
        },
        children: [],
      },
      "metrics-row": {
        type: "Stack",
        props: { direction: "horizontal", gap: 3, wrap: true },
        children: ["humidity-metric", "wind-metric", "rain-metric"],
      },
      "humidity-metric": {
        type: "Metric",
        props: { label: "Humidity", value: `${snapshot.humidity}%` },
        children: [],
      },
      "wind-metric": {
        type: "Metric",
        props: { label: "Wind", value: `${snapshot.windKph} km/h` },
        children: [],
      },
      "rain-metric": {
        type: "Metric",
        props: { label: "Rain chance", value: `${snapshot.chanceOfRain}%` },
        children: [],
      },
      "weather-alert": {
        type: "Alert",
        props: {
          variant: conditionVariant(snapshot.condition),
          message:
            snapshot.chanceOfRain >= 60
              ? "Carry an umbrella."
              : snapshot.windKph >= 30
                ? "Expect gusty conditions."
                : "Conditions are stable.",
        },
        children: [],
      },
    },
  };
}

async function postWeatherReply(input: {
  client: MessageLayerClient;
  streamType: "channel" | "thread";
  channelId: string;
  parentMessageId: string;
  targetThreadId: string | null;
  snapshot: WeatherSnapshot;
}): Promise<
  | { ok: true; messageId: string }
  | { ok: false; message: string; requestId?: string }
> {
  let threadId = input.targetThreadId;
  if (input.streamType === "channel") {
    const created = await input.client.createThread(input.channelId, input.parentMessageId, "public");
    if (!created.ok) {
      return { ok: false, message: created.message, requestId: created.requestId };
    }
    threadId = created.threadId;
  }
  if (!threadId) return { ok: false, message: "missing target thread id" };

  const condition = conditionLabel(input.snapshot.condition);
  const unitSuffix = input.snapshot.unit === "c" ? "C" : "F";
  const text = `Weather for ${input.snapshot.city}: ${input.snapshot.temperature}°${unitSuffix}, ${condition.toLowerCase()}, humidity ${input.snapshot.humidity}%.`;
  const appended = await input.client.appendParts({
    streamId: threadId,
    streamType: "thread",
    parts: [
      { type: "text", payload: { text } },
      {
        type: "ui",
        payload: {
          catalog: "shadcn",
          spec: createWeatherUiSpec(input.snapshot),
        },
      },
    ],
  });
  if (!appended.ok) {
    return { ok: false, message: appended.message, requestId: appended.requestId };
  }
  return { ok: true, messageId: appended.messageId };
}

type ParsedArgs = {
  help: boolean;
  once: boolean;
  orgId?: string;
  baseUrl?: string;
  healthUrl?: string;
  intervalMs?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eat = (): string | undefined => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--once") out.once = true;
    else if (arg === "--org-id" || arg === "--org" || arg.startsWith("--org-id=") || arg.startsWith("--org="))
      out.orgId = eat();
    else if (arg === "--base-url" || arg.startsWith("--base-url=")) out.baseUrl = eat();
    else if (arg === "--health-url" || arg.startsWith("--health-url=")) out.healthUrl = eat();
    else if (arg === "--interval-ms" || arg.startsWith("--interval-ms=")) out.intervalMs = eat();
  }
  return out;
}

function printUsage(): void {
  console.log(`weather agent — emits a generative UI weather card on /weather-check

Usage:
  pnpm start --org-id <orgId> [flags]
  pnpm run once --org-id <orgId>

Flags:
  --org-id <id>         Org the agent should join (required; or MESSAGE_LAYER_ORG_ID)
  --base-url <url>      message-layer base URL (default: http://127.0.0.1:3000)
  --health-url <url>    Next.js health URL (default: http://localhost:3001)
  --interval-ms <ms>    polling cadence (default: 10000)
  --once                run one poll cycle and exit
  -h, --help            show this message
`);
}

void main().catch((error) => {
  console.error(`[weather] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
