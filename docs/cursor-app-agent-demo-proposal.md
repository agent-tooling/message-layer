# Cursor app/agent demo proposal (Next.js client + agents runtime)

## Goal

Build a demo in this repository where a "Cursor app/agent" behaves similarly to
the Cursor Slack app:

- humans invoke the agent from a channel/thread
- the agent runs tools and posts progress back into the conversation
- privileged actions pause for human approval
- approvals happen in-product and the run resumes

This proposal is intentionally scoped to existing primitives already present in
`message-layer`, `clients/nextjs`, and `agents/*`.

## Existing capabilities we can reuse

### Next.js client (`clients/nextjs`)

- Agent onboarding + approval lifecycle
  - `POST /api/team/agents/join-requests`
  - `POST /api/team/agents/join-requests/[requestId]/resolve`
  - Admin UI: `app/admin/agents/*`
- Agent auth discovery/session
  - `GET /.well-known/agent-configuration`
  - `GET /api/team/agent/session`
- Human approval inbox for permission requests
  - `GET /api/team/permission-requests`
  - `POST /api/team/permission-requests/[requestId]/resolve`
- Rich message part rendering in UI
  - `text`, `tool_call`, `tool_result`, `approval_request`,
    `approval_response`, `artifact`, `ui`

### Agents runtime (`agents/assistant`, `agents/poet`)

- Reusable bootstrap flow to create/poll join requests
- WebSocket subscription loop over `message.appended`
- Tool wrappers that encode denied + `permissionRequestId` outcomes
- Structured trace publishing back into channels

### Core runtime (`src/agent-kernel`)

- `AgentKernel` already supports:
  - tool-call interception
  - permission request creation
  - pause/wait on approval
  - approval response handling
  - publishing `tool_call`, `tool_result`, and text parts

## Proposed architecture

Implement the demo as two cooperating components:

1. **Cursor app control plane (Next.js)**
   - Install/onboard agent actor
   - Expose "Ask Cursor" entrypoint in message/thread UX
   - Show run status and approval state in conversation UI
   - Reuse admin + approval pages for governance

2. **Cursor runtime daemon (`agents/cursor`)**
   - Subscribes to channel/thread events
   - Detects invocation (`@cursor`, slash-like command, or message part flag)
   - Executes via `AgentKernel`
   - Streams structured output back to channel/thread
   - Pauses and resumes automatically based on approval outcomes

This mirrors the Slack mental model:

- app surface in product
- execution outside product
- auditable message trail for every action

## MVP implementation plan

### Phase 1: runtime skeleton (`agents/cursor`)

- Create `agents/cursor` package by adapting `agents/assistant`:
  - bootstrap/join flow
  - ws subscribe loop
  - trigger detection
- Wire execution to `AgentKernel`:
  - set stream context (channel or thread)
  - prompt from user invocation text
  - publish progress parts to the same stream

### Phase 2: invocation UX in Next.js

- Add "Ask Cursor" affordance in `MessageCard` / thread context
- Initial trigger option:
  - mention pattern (`@cursor ...`) or
  - explicit action button that posts a structured invocation message
- Keep UI simple:
  - a small badge/card for "Cursor run started"
  - rely on existing part rendering for tool/progress details

### Phase 3: approvals + run lifecycle

- Reuse existing permission request inbox
- Ensure runtime posts clear status parts:
  - waiting for approval
  - approved/resumed
  - denied/stopped
- Reuse admin pages for revoke/kick and grant introspection

### Phase 4: demo polish

- Add lightweight run metadata in message parts (`runId`, status, timestamps)
- Add one or two deterministic demo prompts in `smoke-tests/`
- Document setup/run steps for local demos

## Message contract for Cursor runs (recommended)

Use existing part types and stable payload keys:

- `text`: natural language status + final answer
- `tool_call`: `{ toolName, args, toolCallId, runId }`
- `tool_result`: `{ toolName, content, isError, toolCallId, runId }`
- `approval_request`: `{ requestId, toolName, toolCallId, runId }`
- `approval_response`: `{ requestId, approved, runId }`
- `artifact`: file/link outputs from tools
- optional `ui`: richer run summary cards

This keeps the protocol transparent and backward-compatible with current UI.

## Security and governance notes

- Keep all action checks in service permissions (already true in architecture)
- Continue converting denied actions into explicit permission requests
- Scope grants to resource + capability + expiry/max uses where possible
- Preserve full audit chain for run actions and approval decisions

## Why this is a good fit for this codebase

- Message-first model is already aligned with agent transcripts
- Permission-first flow already exists and is user-visible
- Web + daemon split follows current boundaries (no direct DB access)
- We can ship a realistic demo without major schema or transport changes

## Suggested first coding tasks

1. Scaffold `agents/cursor` from `agents/assistant`
2. Add invocation detection and thread targeting
3. Hook `AgentKernel` into runtime loop
4. Add "Ask Cursor" action in `clients/nextjs/components/message-card.tsx`
5. Add one smoke-test doc that walks through:
   - invoke
   - approval request
   - approve
   - resumed completion
