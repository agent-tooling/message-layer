"use client";

import type { MessageRecord } from "@/lib/message-layer-client";

interface Props {
  message: MessageRecord;
  isAgent: boolean;
}

export default function MessageBubble({ message, isAgent }: Props) {
  const hasTool = message.parts.some((p) => p.type === "tool_call" || p.type === "tool_result");

  return (
    <div className={`flex flex-col gap-1 max-w-3xl ${isAgent ? "self-start" : "self-end"}`}>
      <span className={`text-xs ${isAgent ? "text-emerald-500" : "text-sky-400"}`}>
        {isAgent ? "agent" : "you"}
        <span className="text-zinc-600 ml-2">seq {message.streamSeq}</span>
      </span>

      {message.parts.map((part, i) => {
        if (part.type === "text") {
          const text = String(part.payload.text ?? "");
          return (
            <div
              key={i}
              className={`px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                isAgent
                  ? "bg-zinc-800 text-zinc-100"
                  : "bg-sky-900 text-sky-100"
              }`}
            >
              {text}
            </div>
          );
        }

        if (part.type === "tool_call") {
          return (
            <div key={i} className="px-3 py-2 rounded-lg bg-zinc-900 border border-yellow-800 text-xs">
              <div className="text-yellow-400 font-bold">▶ {String(part.payload.toolName)}</div>
              <pre className="text-zinc-400 mt-1 overflow-x-auto text-xs">
                {JSON.stringify(part.payload.args, null, 2)}
              </pre>
            </div>
          );
        }

        if (part.type === "tool_result") {
          const isError = Boolean(part.payload.isError);
          const content = String(part.payload.content ?? "").slice(0, 600);
          return (
            <div
              key={i}
              className={`px-3 py-2 rounded-lg text-xs border ${
                isError
                  ? "bg-red-950 border-red-800 text-red-300"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400"
              }`}
            >
              <div className={`font-bold mb-1 ${isError ? "text-red-400" : "text-zinc-500"}`}>
                {isError ? "✗" : "✓"} {String(part.payload.toolName)}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap">{content}</pre>
            </div>
          );
        }

        if (part.type === "approval_request") {
          return (
            <div key={i} className="px-3 py-2 rounded-lg bg-yellow-950 border border-yellow-700 text-xs">
              <div className="text-yellow-400 font-bold">⚠ Approval requested</div>
              <div className="text-zinc-300 mt-1">tool: {String(part.payload.toolName)}</div>
              <div className="text-zinc-500 text-xs">id: {String(part.payload.requestId)}</div>
            </div>
          );
        }

        if (part.type === "approval_response") {
          const approved = Boolean(part.payload.approved);
          return (
            <div key={i} className={`px-3 py-2 rounded-lg text-xs border ${approved ? "bg-emerald-950 border-emerald-800 text-emerald-300" : "bg-red-950 border-red-800 text-red-300"}`}>
              {approved ? "✓ Approved" : "✗ Denied"}
              <span className="text-zinc-500 ml-2">id: {String(part.payload.requestId)}</span>
            </div>
          );
        }

        if (part.type === "artifact") {
          return (
            <div key={i} className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-600 text-xs text-zinc-400">
              📎 artifact
              <pre className="mt-1 overflow-x-auto">{JSON.stringify(part.payload, null, 2)}</pre>
            </div>
          );
        }

        return null;
      })}

      {hasTool && (
        <div className="text-xs text-zinc-600 pl-1">{new Date(message.createdAt).toLocaleTimeString()}</div>
      )}
    </div>
  );
}
