from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, Iterable

from .models import PART_TYPES, MessagePart, Principal


class PermissionError(Exception):
    pass


class MessageLayer:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _id() -> str:
        return uuid.uuid4().hex

    @contextmanager
    def _tx(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def _event(self, org_id: str, event_type: str, payload: dict[str, Any], stream_id: str | None = None, stream_seq: int | None = None):
        self.conn.execute(
            "INSERT INTO events(id,org_id,stream_id,event_type,payload_json,stream_seq,created_at) VALUES (?,?,?,?,?,?,?)",
            (self._id(), org_id, stream_id, event_type, json.dumps(payload), stream_seq, self._now()),
        )
        self._audit(org_id, event_type, payload)

    def _audit(self, org_id: str, event_type: str, payload: dict[str, Any]):
        prev = self.conn.execute(
            "SELECT event_hash FROM audit_events WHERE org_id=? ORDER BY created_at DESC LIMIT 1", (org_id,)
        ).fetchone()
        prev_hash = prev[0] if prev else ""
        body = json.dumps(payload, sort_keys=True)
        created_at = self._now()
        event_hash = hashlib.sha256(f"{prev_hash}|{event_type}|{body}|{created_at}".encode()).hexdigest()
        self.conn.execute(
            "INSERT INTO audit_events(id,org_id,event_type,payload_json,prev_hash,event_hash,created_at) VALUES (?,?,?,?,?,?,?)",
            (self._id(), org_id, event_type, body, prev_hash or None, event_hash, created_at),
        )

    def _assert_org_actor(self, principal: Principal):
        row = self.conn.execute(
            "SELECT 1 FROM actors WHERE id=? AND org_id=?", (principal.actor_id, principal.org_id)
        ).fetchone()
        if not row:
            raise PermissionError("actor is not in org")

    def _has_grant(self, principal: Principal, capability: str, resource_type: str, resource_id: str | None) -> bool:
        now = self._now()
        row = self.conn.execute(
            """
            SELECT 1 FROM grants
            WHERE org_id=? AND actor_id=? AND capability=? AND resource_type=? AND active=1
              AND (resource_id IS NULL OR resource_id=?)
              AND (expires_at IS NULL OR expires_at>?)
            LIMIT 1
            """,
            (principal.org_id, principal.actor_id, capability, resource_type, resource_id, now),
        ).fetchone()
        return bool(row) or capability in principal.scopes

    def create_org(self, name: str) -> str:
        org_id = self._id()
        self.conn.execute(
            "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)", (org_id, name, self._now())
        )
        self._event(org_id, "org.created", {"orgId": org_id, "name": name})
        return org_id

    def create_actor(self, org_id: str, actor_type: str, display_name: str) -> str:
        actor_id = self._id()
        self.conn.execute(
            "INSERT INTO actors(id,org_id,type,display_name,created_at) VALUES (?,?,?,?,?)",
            (actor_id, org_id, actor_type, display_name, self._now()),
        )
        self.conn.execute(
            "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
            (self._id(), org_id, actor_id, None, "member", "{}", self._now()),
        )
        self._event(org_id, "membership.updated", {"actorId": actor_id, "orgId": org_id})
        return actor_id

    def create_channel(self, principal: Principal, name: str, visibility: str = "private") -> str:
        self._assert_org_actor(principal)
        if not self._has_grant(principal, "channel:create", "org", principal.org_id):
            raise PermissionError("missing channel:create")
        channel_id = self._id()
        self.conn.execute(
            "INSERT INTO channels(id,org_id,name,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?)",
            (channel_id, principal.org_id, name, visibility, principal.actor_id, self._now()),
        )
        self.conn.execute(
            "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
            (self._id(), principal.org_id, principal.actor_id, channel_id, "owner", "{}", self._now()),
        )
        self._event(principal.org_id, "channel.created", {"channelId": channel_id, "name": name}, stream_id=channel_id)
        return channel_id

    def create_thread(self, principal: Principal, channel_id: str, parent_message_id: str, visibility: str = "private") -> str:
        self._assert_org_actor(principal)
        if not self._has_grant(principal, "thread:create", "channel", channel_id):
            raise PermissionError("missing thread:create")
        thread_id = self._id()
        self.conn.execute(
            "INSERT INTO threads(id,org_id,channel_id,parent_message_id,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?)",
            (thread_id, principal.org_id, channel_id, parent_message_id, visibility, principal.actor_id, self._now()),
        )
        self._event(principal.org_id, "thread.created", {"threadId": thread_id, "channelId": channel_id}, stream_id=thread_id)
        return thread_id

    def _next_seq(self, stream_id: str) -> int:
        row = self.conn.execute("SELECT next_seq FROM stream_counters WHERE stream_id=?", (stream_id,)).fetchone()
        if not row:
            self.conn.execute("INSERT INTO stream_counters(stream_id,next_seq) VALUES (?,?)", (stream_id, 2))
            return 1
        seq = int(row[0])
        self.conn.execute("UPDATE stream_counters SET next_seq=? WHERE stream_id=?", (seq + 1, stream_id))
        return seq

    def append_message(
        self,
        principal: Principal,
        stream_id: str,
        stream_type: str,
        parts: Iterable[MessagePart],
        idempotency_key: str,
    ) -> dict[str, Any]:
        self._assert_org_actor(principal)
        capability = "message:append"
        if not self._has_grant(principal, capability, stream_type, stream_id):
            raise PermissionError("missing message:append")
        part_list = list(parts)
        for part in part_list:
            if part.type not in PART_TYPES:
                raise ValueError(f"invalid part type: {part.type}")

        with self._tx():
            existing = self.conn.execute(
                "SELECT id,stream_seq FROM messages WHERE org_id=? AND stream_id=? AND actor_id=? AND idempotency_key=?",
                (principal.org_id, stream_id, principal.actor_id, idempotency_key),
            ).fetchone()
            if existing:
                return {"messageId": existing[0], "streamSeq": existing[1], "idempotent": True}

            message_id = self._id()
            seq = self._next_seq(stream_id)
            self.conn.execute(
                "INSERT INTO messages(id,org_id,stream_id,stream_type,actor_id,stream_seq,idempotency_key,created_at,redacted) VALUES (?,?,?,?,?,?,?,?,0)",
                (message_id, principal.org_id, stream_id, stream_type, principal.actor_id, seq, idempotency_key, self._now()),
            )
            for idx, part in enumerate(part_list):
                self.conn.execute(
                    "INSERT INTO message_parts(id,message_id,part_index,part_type,payload_json) VALUES (?,?,?,?,?)",
                    (self._id(), message_id, idx, part.type, json.dumps(part.payload)),
                )
            self._event(
                principal.org_id,
                "message.appended",
                {"messageId": message_id, "streamId": stream_id, "streamSeq": seq, "parts": len(part_list)},
                stream_id=stream_id,
                stream_seq=seq,
            )
            return {"messageId": message_id, "streamSeq": seq, "idempotent": False}

    def list_messages(self, principal: Principal, stream_id: str, after_seq: int = 0, limit: int = 50) -> list[dict[str, Any]]:
        self._assert_org_actor(principal)
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE org_id=? AND stream_id=? AND stream_seq>? ORDER BY stream_seq ASC LIMIT ?",
            (principal.org_id, stream_id, after_seq, limit),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            parts = self.conn.execute(
                "SELECT part_index,part_type,payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
                (row["id"],),
            ).fetchall()
            out.append(
                {
                    "id": row["id"],
                    "streamSeq": row["stream_seq"],
                    "actorId": row["actor_id"],
                    "parts": [
                        {"index": p[0], "type": p[1], "payload": json.loads(p[2])} for p in parts
                    ],
                }
            )
        return out

    def subscribe(self, principal: Principal, stream_id: str, from_seq: int = 0) -> list[dict[str, Any]]:
        self._assert_org_actor(principal)
        rows = self.conn.execute(
            "SELECT event_type,payload_json,stream_seq,created_at FROM events WHERE org_id=? AND stream_id=? AND COALESCE(stream_seq,0)>? ORDER BY COALESCE(stream_seq,0) ASC, created_at ASC",
            (principal.org_id, stream_id, from_seq),
        ).fetchall()
        return [
            {"type": r[0], "payload": json.loads(r[1]), "streamSeq": r[2], "createdAt": r[3]}
            for r in rows
        ]

    def update_cursor(self, principal: Principal, stream_id: str, last_seen_seq: int, last_ack_seq: int):
        self._assert_org_actor(principal)
        self.conn.execute(
            """
            INSERT INTO cursors(id,org_id,actor_id,stream_id,last_seen_seq,last_ack_seq,updated_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(org_id,actor_id,stream_id)
            DO UPDATE SET last_seen_seq=excluded.last_seen_seq,last_ack_seq=excluded.last_ack_seq,updated_at=excluded.updated_at
            """,
            (self._id(), principal.org_id, principal.actor_id, stream_id, last_seen_seq, last_ack_seq, self._now()),
        )
        self._event(principal.org_id, "cursor.updated", {"actorId": principal.actor_id, "streamId": stream_id})

    def create_grant(
        self,
        principal: Principal,
        actor_id: str,
        resource_type: str,
        resource_id: str | None,
        capability: str,
        expires_at: str | None = None,
        constraints: dict[str, Any] | None = None,
    ) -> str:
        if "grant:create" not in principal.scopes:
            raise PermissionError("missing grant:create")
        grant_id = self._id()
        self.conn.execute(
            "INSERT INTO grants(id,org_id,actor_id,resource_type,resource_id,capability,expires_at,constraints_json,active,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
            (
                grant_id,
                principal.org_id,
                actor_id,
                resource_type,
                resource_id,
                capability,
                expires_at,
                json.dumps(constraints or {}),
                principal.actor_id,
                self._now(),
            ),
        )
        self._event(principal.org_id, "grant.created", {"grantId": grant_id, "actorId": actor_id})
        return grant_id

    def revoke_grant(self, principal: Principal, grant_id: str):
        if "grant:create" not in principal.scopes:
            raise PermissionError("missing grant:create")
        self.conn.execute("UPDATE grants SET active=0 WHERE id=? AND org_id=?", (grant_id, principal.org_id))
        self._event(principal.org_id, "grant.revoked", {"grantId": grant_id})

    def create_permission_request(
        self, principal: Principal, action: str, resource_type: str, resource_id: str | None
    ) -> str:
        req_id = self._id()
        self.conn.execute(
            "INSERT INTO permission_requests(id,org_id,actor_id,action,resource_type,resource_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (req_id, principal.org_id, principal.actor_id, action, resource_type, resource_id, "open", self._now()),
        )
        self._event(principal.org_id, "permission_request.created", {"requestId": req_id})
        return req_id

    def resolve_permission_request(self, principal: Principal, request_id: str, approve: bool, notes: str = ""):
        if "grant:create" not in principal.scopes:
            raise PermissionError("missing grant:create")
        req = self.conn.execute(
            "SELECT actor_id,action,resource_type,resource_id,status FROM permission_requests WHERE id=? AND org_id=?",
            (request_id, principal.org_id),
        ).fetchone()
        if not req or req[4] != "open":
            raise ValueError("request not open")
        grant_id = None
        status = "denied"
        if approve:
            grant_id = self.create_grant(
                principal,
                actor_id=req[0],
                resource_type=req[2],
                resource_id=req[3],
                capability=req[1],
            )
            status = "approved"
        self.conn.execute(
            "UPDATE permission_requests SET status=?,resolution_notes=?,resolver_actor_id=?,grant_id=?,resolved_at=? WHERE id=?",
            (status, notes, principal.actor_id, grant_id, self._now(), request_id),
        )
        self._event(principal.org_id, "permission_request.resolved", {"requestId": request_id, "status": status})

    def register_client(self, principal: Principal, endpoint: str, metadata: dict[str, Any] | None = None) -> str:
        client_id = self._id()
        self.conn.execute(
            "INSERT INTO clients(id,org_id,actor_id,endpoint,metadata_json,created_at) VALUES (?,?,?,?,?,?)",
            (client_id, principal.org_id, principal.actor_id, endpoint, json.dumps(metadata or {}), self._now()),
        )
        return client_id
