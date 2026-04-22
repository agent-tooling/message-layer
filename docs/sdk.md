# TypeScript SDK

The `message-layer/sdk` subpath exports a typed HTTP client for the
message-layer API. It works in Node.js and any environment with a global
`fetch` and `WebSocket`.

```bash
npm install message-layer
```

```typescript
import { MessageLayerClient } from "message-layer/sdk";
```

---

## `MessageLayerClient`

### Constructor

```typescript
new MessageLayerClient(options: MessageLayerClientOptions)
```

#### `MessageLayerClientOptions`

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Base URL of the message-layer server, e.g. `http://localhost:3000`. Trailing slashes are stripped. |
| `principal` | `Principal` | no | Authenticated principal sent on every request as `x-principal`. Required for all methods except `createOrg` and `createActor`. |
| `apiKey` | `string` | no | Shared secret for servers protected by the `api-key-header-auth` plugin. Sent as the `x-api-key` header on every HTTP request and as a query param on WebSocket URLs. |
| `apiKeyHeader` | `string` | no | Header name the server expects the API key in. Defaults to `x-api-key`. Override if the plugin was configured with a custom `headerName`. |
| `fetch` | `typeof globalThis.fetch` | no | Custom fetch implementation. Useful for testing or injecting middleware (e.g. `cache: "no-store"` for Next.js). |

#### `Principal`

```typescript
type Principal = {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
};
```

#### Examples

Minimal (local dev, no auth):

```typescript
const client = new MessageLayerClient({
  baseUrl: "http://localhost:3000",
  principal: { actorId: "actor_123", orgId: "org_456", scopes: [], provider: "dev" },
});
```

Public server with API key:

```typescript
const client = new MessageLayerClient({
  baseUrl: "https://ml.example.com",
  apiKey: process.env.MESSAGE_LAYER_API_KEY,
  principal: { actorId, orgId, scopes: [], provider: "myapp" },
});
```

Bootstrap client (no principal — for `createOrg` / `createActor`):

```typescript
const boot = new MessageLayerClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.MESSAGE_LAYER_API_KEY,
});
```

Next.js server component / route handler (disable Next.js response cache):

```typescript
const client = new MessageLayerClient({
  baseUrl: env.MESSAGE_LAYER_BASE_URL,
  principal,
  fetch: (input, init) => fetch(input as RequestInfo, { ...init as RequestInit, cache: "no-store" }),
});
```

---

## Methods

### Orgs

#### `createOrg(name: string): Promise<{ orgId: string }>`

Create a new organization. **Unauthenticated** — no `principal` required.

```typescript
const { orgId } = await boot.createOrg("My Workspace");
```

---

### Actors

#### `createActor(input): Promise<{ actorId: string }>`

Create an actor. **Unauthenticated** — no `principal` required.

```typescript
type input = {
  orgId: string;
  displayName: string;
  actorType: "human" | "agent" | "app";
};
```

```typescript
const { actorId } = await boot.createActor({
  orgId,
  displayName: "Alice",
  actorType: "human",
});
```

#### `listActors(): Promise<Actor[]>`

List all actors in the principal's org.

```typescript
type Actor = {
  actorId: string;
  displayName: string;
  actorType: "human" | "agent" | "app";
  createdAt: string;
};
```

#### `revokeAllGrantsForActor(actorId: string, reason?: string): Promise<{ revokedGrantIds: string[] }>`

Revoke every active grant held by an actor ("kick"). Requires `grant:create` scope.

#### `listActorGrants(actorId: string): Promise<GrantRecord[]>`

List all active grants held by a specific actor.

```typescript
type GrantRecord = {
  grantId: string;
  actorId: string;
  resourceType: string;
  resourceId: string | null;
  capability: string;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
  remainingUses: number | null;
  constraints: Record<string, unknown>;
  createdAt: string;
  createdByActorId: string;
};
```

---

### Members

#### `listMembers(): Promise<OrgMember[]>`

List org memberships.

```typescript
type OrgMember = {
  actorId: string;
  displayName: string;
  actorType: string;
  role: string;
};
```

---

### Channels

#### `listChannels(): Promise<Channel[]>`

List channels visible to the principal.

```typescript
type Channel = {
  id: string;
  name: string;
  visibility: "public" | "private";
};
```

#### `createChannel(name: string, visibility?: "public" | "private"): Promise<{ channelId: string }>`

Create a channel. Requires `channel:create`. `visibility` defaults to `"public"`.

#### `addChannelMember(channelId: string, actorId: string, role?: string): Promise<void>`

Add a member to a channel. `role` defaults to `"member"`.

#### `removeChannelMember(channelId: string, actorId: string): Promise<void>`

Remove a member from a channel.

#### `listChannelMembers(channelId: string): Promise<ChannelMember[]>`

```typescript
type ChannelMember = {
  actorId: string;
  role: string;
  createdAt: string;
};
```

---

### Threads

#### `listThreads(channelId: string): Promise<Thread[]>`

```typescript
type Thread = {
  id: string;
  parentMessageId: string;
  visibility: "public" | "private";
};
```

#### `createThread(channelId: string, parentMessageId: string, visibility?: "public" | "private"): Promise<{ threadId: string }>`

Create a thread anchored to a message in a channel. Requires `thread:create`.

---

### Messages

#### `appendMessage(input: AppendMessageInput): Promise<AppendMessageResult>`

Append a message to a channel or thread. Requires `message:append`.

```typescript
type AppendMessageInput = {
  streamId: string;
  streamType: "channel" | "thread";
  parts: MessagePart[];
  idempotencyKey?: string;   // client-chosen dedupe key
  autoRequestOnDeny?: boolean; // open a permission request instead of throwing on 403
};

type MessagePart = {
  type: "text" | "tool_call" | "tool_result" | "artifact" | "approval_request" | "approval_response";
  payload: Record<string, unknown>;
};
```

Success response:

```typescript
type AppendMessageResult =
  | { ok: true; messageId: string; denied?: false }           // message appended
  | { ok: false; denied: true; permissionRequestId: string; capability: string }; // autoRequestOnDeny triggered
```

Example — send a text message:

```typescript
await client.appendMessage({
  streamId: channelId,
  streamType: "channel",
  parts: [{ type: "text", payload: { text: "Hello!" } }],
  idempotencyKey: crypto.randomUUID(),
});
```

Example — handle denied case:

```typescript
const result = await client.appendMessage({
  streamId: channelId,
  streamType: "channel",
  parts: [{ type: "text", payload: { text: "Please approve me" } }],
  idempotencyKey: "agent-msg-1",
  autoRequestOnDeny: true,
});

if (!result.ok && result.denied) {
  console.log("Permission request opened:", result.permissionRequestId);
}
```

#### `listMessages(streamId: string, options?): Promise<MessageRecord[]>`

List messages in a stream, ordered by `streamSeq` ascending.

```typescript
// options
{ afterSeq?: number; limit?: number }
```

```typescript
type MessageRecord = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  redacted: boolean;
  redactedAt: string | null;
  parts: Array<{ index: number; type: string; payload: Record<string, unknown> }>;
};
```

#### `redactMessage(messageId: string, reason?: string): Promise<void>`

---

### Cursors

#### `updateCursor(streamId: string, streamType: "channel" | "thread", lastSeq: number): Promise<void>`

Update the principal's read cursor.

#### `getCursor(streamId: string): Promise<{ streamId: string; lastSeq: number } | null>`

---

### Grants

#### `createGrant(input: CreateGrantInput): Promise<{ grantId: string }>`

```typescript
type CreateGrantInput = {
  actorId: string;
  resourceType: "org" | "channel" | "thread";
  resourceId: string | null;  // null = any resource of this type
  capability: string;
  expiresAt?: string | null;  // ISO-8601
  maxUses?: number | null;    // null = unlimited; 1 = "approve once"
};
```

#### `revokeGrant(grantId: string): Promise<void>`

#### `checkCapability(actorId: string, capability: string): Promise<boolean>`

Returns `true` if the actor currently holds an active grant for the capability.

---

### Permission requests

#### `createPermissionRequest(input: CreatePermissionRequestInput): Promise<{ requestId: string }>`

```typescript
type CreatePermissionRequestInput = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  context?: Record<string, unknown>; // human-readable context for the reviewer
};
```

#### `listPermissionRequests(actorId?: string): Promise<PermissionRequest[]>`

List open requests, optionally filtered by actor.

```typescript
type PermissionRequest = {
  requestId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
};
```

#### `resolvePermissionRequest(requestId: string, approve: boolean, options?: ResolveOptions): Promise<void>`

```typescript
type ResolveOptions = {
  notes?: string;
  expiresAt?: string | null;  // ISO-8601 expiry for the issued grant
  maxUses?: number | null;    // usage cap for the issued grant
};
```

---

### Artifacts

#### `registerArtifact(input: RegisterArtifactInput): Promise<ArtifactRecord>`

Upload a binary artifact scoped to a stream.

```typescript
type RegisterArtifactInput = {
  streamId: string;
  streamType: "channel" | "thread";
  filename: string;
  contentType: string;
  content: Uint8Array | string; // raw bytes or base64-encoded string
  sha256?: string;              // optional; validated against server-computed digest
};
```

```typescript
type ArtifactRecord = {
  id: string;
  orgId: string;
  streamId: string;
  streamType: "channel" | "thread";
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKind: string;
  createdByActorId: string;
  createdAt: string;
  deleted: boolean;
};
```

#### `listStreamArtifacts(streamId: string): Promise<ArtifactRecord[]>`

---

### Audit

#### `fetchAuditRows(options?): Promise<AuditRow[]>`

Requires `audit:read` scope.

```typescript
// options
{ actorId?: string; limit?: number }
```

```typescript
type AuditRow = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  eventHash: string;
  createdAt: string;
};
```

---

### Memory (memory plugin)

These methods require the `memory` plugin to be enabled on the server.

#### `listMemory(streamId: string): Promise<MemoryUnit[]>`

List derived memory units bound to a stream the principal can read.

#### `listPromotedMemory(): Promise<MemoryUnit[]>`

List org-wide promoted memory units.

#### `searchMemory(query: string, options?: { streamId?: string; limit?: number }): Promise<{ query: string; hits: MemoryHit[] }>`

Lexical search across memory units the principal can see (their visible
streams + org-wide promoted units).

#### `getMemory(memoryId: string): Promise<MemoryUnit>`

#### `promoteMemory(memoryId: string, summary?: string): Promise<MemoryUnit>`

Requires `memory:promote` (scope or grant on the org).

```typescript
type MemoryUnit = {
  id: string;
  orgId: string;
  sourceStreamId: string;
  sourceStreamType: "channel" | "thread";
  sourceVisibility: "private" | "public";
  canonicalText: string;
  summary: string;
  keywords: string[];
  createdByActorId: string;
  sourceMessageIds: string[];
  promoted: boolean;
  promotedAt: string | null;
  promotedByActorId: string | null;
  promotionSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

type MemoryHit = {
  unit: MemoryUnit;
  score: number;
  highlights: string[];
};
```

---

### Search (search plugin)

These methods require the `search` plugin to be enabled on the server.
When the `memory` plugin is also enabled, memory units are included in
results and can be filtered with `entityTypes: ["memory"]`.

#### `search(query: string, options?: SearchOptions): Promise<{ query: string; hits: SearchHit[] }>`

Mixed-entity search across actors, channels, threads, messages, and
memory units. Privacy is delegated to core `assertCanReadStream` and
org-membership checks.

#### `searchSuggest(query: string, options?: { limit?: number }): Promise<{ query: string; suggestions: SearchSuggestion[] }>`

```typescript
type SearchOptions = {
  entityTypes?: Array<"actor" | "channel" | "thread" | "message" | "memory">;
  streamId?: string;
  actorType?: "human" | "agent" | "app";
  limit?: number;
};

type SearchHit = {
  documentId: string;
  entityType: "actor" | "channel" | "thread" | "message" | "memory";
  entityId: string;
  score: number;
  title: string;
  snippet: string;
  highlights: string[];
  sourceStreamId: string | null;
  sourceStreamType: "channel" | "thread" | null;
  sourceVisibility: "private" | "public" | null;
  promoted: boolean;
  actorType: "human" | "agent" | "app" | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

type SearchSuggestion = {
  entityType: "actor" | "channel" | "thread" | "message" | "memory";
  entityId: string;
  label: string;
  actorType: "human" | "agent" | "app" | null;
};
```

---

### Webhooks (webhooks plugin)

These methods require the `webhooks` plugin to be enabled on the server.

#### `listWebhookSubscriptions(): Promise<WebhookSubscription[]>`

```typescript
type WebhookSubscription = {
  id: string;
  orgId: string;
  actorId: string;
  endpoint: string;
  eventTypes: string[];
  streamId: string | null;
  enabled: boolean;
  createdAt: string;
};
```

---

### WebSocket

#### `subscribe(streamId, options): WebSocketHandle`

Open a WebSocket subscription for realtime event delivery on a stream.
Replays missed events from `fromSeq` first, then pushes live events.

```typescript
// options
{
  streamType?: "channel" | "thread";  // defaults to "channel"
  fromSeq?: number;                   // defaults to 0
  onEvent: (event: WebSocketEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  WebSocket?: typeof globalThis.WebSocket; // override for Node.js (use the `ws` package)
}

type WebSocketEvent = {
  type: string;
  payload: Record<string, unknown>;
  streamSeq: number;
  createdAt: string;
};

type WebSocketHandle = {
  close: () => void;
};
```

**Browser example:**

```typescript
const handle = client.subscribe(channelId, {
  fromSeq: lastKnownSeq,
  onEvent: (event) => {
    if (event.type === "message.appended") {
      renderMessage(event.payload);
    }
  },
  onError: console.error,
});

// cleanup
handle.close();
```

**Node.js example** (using the `ws` package):

```typescript
import { WebSocket } from "ws";

const handle = client.subscribe(channelId, {
  WebSocket,
  fromSeq: 0,
  onEvent: (event) => console.log(event),
});
```

The `apiKey` (if set) is included as a query param on the WebSocket URL so the
`api-key-header-auth` plugin can authenticate the upgrade request. The
`principal` is also passed as a query param (`?principal=<json>`) on the WebSocket
URL since headers are not available on browser WebSocket upgrades.

---

## Error handling

All SDK methods throw when the server returns a non-2xx response. The error
message contains the HTTP status code and the response body:

```typescript
// "message-layer 401: {"error":"invalid api key"}"
try {
  await client.listChannels();
} catch (err) {
  if ((err as Error).message.includes("401")) {
    // handle auth failure
  }
}
```

Successful `appendMessage` calls with `autoRequestOnDeny: true` **do not
throw** when the message is denied — they return `{ ok: false, denied: true }`.
Only unexpected errors (network failure, 5xx responses) throw.

---

## Type exports

All public types are exported from `message-layer/sdk`:

```typescript
import type {
  MessageLayerClientOptions,
  Principal,
  Actor,
  OrgMember,
  Channel,
  ChannelMember,
  Thread,
  MessagePart,
  MessageRecord,
  AppendMessageInput,
  AppendMessageResult,
  CreateGrantInput,
  GrantRecord,
  CreatePermissionRequestInput,
  PermissionRequest,
  ResolveOptions,
  RegisterArtifactInput,
  ArtifactRecord,
  AuditRow,
  MemoryUnit,
  MemoryHit,
  SearchEntityType,
  SearchHit,
  SearchSuggestion,
  WebhookSubscription,
  WebSocketEvent,
  WebSocketHandle,
} from "message-layer/sdk";
```
