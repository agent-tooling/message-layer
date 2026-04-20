"use client";

import { useEffect, useState } from "react";
import type { Principal } from "@/lib/message-layer-client";

interface Props {
  baseUrl: string;
  principal: Principal;
}

interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export default function ModelSelector({ baseUrl, principal }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Fetch available models via the agent-status API route (if present)
    fetch(`/api/agent/models`, {
      headers: { "x-ml-base": baseUrl, "x-principal": JSON.stringify(principal) },
    })
      .then((r) => r.json() as Promise<{ models: ModelInfo[]; current: string | null }>)
      .then((data) => {
        setModels(data.models ?? []);
        setCurrent(data.current ?? null);
      })
      .catch(() => {
        // API route not available yet — silent fail
      });
  }, [baseUrl, principal]);

  async function setModel(modelId: string) {
    try {
      const res = await fetch(`/api/agent/models`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ml-base": baseUrl, "x-principal": JSON.stringify(principal) },
        body: JSON.stringify({ modelId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { model: string };
        setCurrent(data.model);
      }
    } catch {
      // ignore
    }
    setOpen(false);
  }

  if (models.length === 0) {
    return (
      <div className="text-xs text-zinc-600">
        model selector requires API keys
      </div>
    );
  }

  return (
    <div className="relative">
      <label className="text-xs text-zinc-500 block mb-1">Model</label>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-300 hover:border-zinc-500 transition-colors"
      >
        {current ?? "select…"}
        <span className="float-right text-zinc-600">▾</span>
      </button>
      {open && (
        <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded shadow-xl max-h-48 overflow-y-auto">
          {models.map((m) => (
            <button
              key={`${m.provider}/${m.id}`}
              onClick={() => setModel(`${m.provider}/${m.id}`)}
              className={`w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-800 transition-colors ${current === `${m.provider}/${m.id}` ? "text-emerald-400" : "text-zinc-300"}`}
            >
              {m.provider}/{m.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
