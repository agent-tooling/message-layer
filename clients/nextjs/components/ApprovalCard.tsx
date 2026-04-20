"use client";

import type { PermissionRequest } from "@/lib/message-layer-client";

interface Props {
  approval: PermissionRequest;
  onApprove: (requestId: string) => Promise<void>;
  onDeny: (requestId: string) => Promise<void>;
}

export default function ApprovalCard({ approval, onApprove, onDeny }: Props) {
  const toolName = approval.action.replace("tool:execute:", "");
  return (
    <div className="bg-yellow-950 border border-yellow-800 rounded p-2 flex flex-col gap-2">
      <div className="text-yellow-400 text-xs font-bold truncate">{toolName}</div>
      <div className="text-zinc-400 text-xs truncate">{approval.resourceId}</div>
      <div className="flex gap-2">
        <button
          onClick={() => onApprove(approval.requestId)}
          className="flex-1 text-xs py-1 bg-emerald-700 hover:bg-emerald-600 rounded font-bold transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onDeny(approval.requestId)}
          className="flex-1 text-xs py-1 bg-red-800 hover:bg-red-700 rounded font-bold transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
