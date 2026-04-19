from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Principal:
    actor_id: str
    org_id: str
    scopes: list[str]
    provider: str
    claims: dict[str, Any] | None = None


@dataclass(frozen=True)
class MessagePart:
    type: str
    payload: dict[str, Any]


PART_TYPES = {
    "text",
    "tool_call",
    "tool_result",
    "artifact",
    "approval_request",
    "approval_response",
}
