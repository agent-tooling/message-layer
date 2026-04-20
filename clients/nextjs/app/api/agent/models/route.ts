/**
 * API route: GET  /api/agent/models  — list available models
 *            POST /api/agent/models  — set the active model (body: { modelId: string })
 *
 * Uses Pi's ModelRegistry server-side so API keys never leak to the browser.
 */
import { NextResponse } from "next/server";

// Lazy-loaded Pi modules to avoid requiring them on every request
async function getRegistry() {
  const { AuthStorage, ModelRegistry } = await import("@mariozechner/pi-coding-agent");
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  return modelRegistry;
}

// In-process active model store (single-process dev mode)
let activeModelId: string | null = null;

export async function GET() {
  try {
    const registry = await getRegistry();
    const available = registry.getAvailable();
    const models = available.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: (m as unknown as { name?: string }).name ?? m.id,
    }));
    return NextResponse.json({ models, current: activeModelId });
  } catch (err) {
    console.error("[/api/agent/models GET]", err);
    return NextResponse.json({ models: [], current: null });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { modelId?: string };
    if (!body.modelId) {
      return NextResponse.json({ error: "modelId required" }, { status: 400 });
    }
    const registry = await getRegistry();
    const [provider, id] = body.modelId.includes("/")
      ? body.modelId.split("/", 2)
      : [undefined, body.modelId];
    const model = provider ? registry.find(provider, id) : registry.getAll().find((m) => m.id === id || m.id.includes(id));
    if (!model) {
      return NextResponse.json({ error: `model '${body.modelId}' not found` }, { status: 404 });
    }
    activeModelId = `${model.provider}/${model.id}`;
    return NextResponse.json({ model: activeModelId });
  } catch (err) {
    console.error("[/api/agent/models POST]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
