from __future__ import annotations

import hashlib
import json

import pytest

from message_layer import MessageLayer, MessagePart, PermissionError, Principal, connect


@pytest.fixture
def svc():
    conn = connect(":memory:")
    return MessageLayer(conn)


def test_org_channel_message_thread_and_subscription_e2e(svc: MessageLayer):
    org_id = svc.create_org("Acme")
    admin_id = svc.create_actor(org_id, "human", "admin")
    bot_id = svc.create_actor(org_id, "agent", "bot")

    admin = Principal(actor_id=admin_id, org_id=org_id, scopes=["grant:create", "channel:create"], provider="local")
    bot = Principal(actor_id=bot_id, org_id=org_id, scopes=[], provider="local")

    channel_id = svc.create_channel(admin, "general")
    svc.create_grant(admin, bot_id, "channel", channel_id, "message:append")
    svc.create_grant(admin, bot_id, "channel", channel_id, "thread:create")

    first = svc.append_message(
        bot,
        stream_id=channel_id,
        stream_type="channel",
        parts=[MessagePart(type="text", payload={"text": "hello"})],
        idempotency_key="bot-1",
    )
    assert first["streamSeq"] == 1

    second = svc.append_message(
        bot,
        stream_id=channel_id,
        stream_type="channel",
        parts=[MessagePart(type="tool_call", payload={"name": "lookup"})],
        idempotency_key="bot-2",
    )
    assert second["streamSeq"] == 2

    dup = svc.append_message(
        bot,
        stream_id=channel_id,
        stream_type="channel",
        parts=[MessagePart(type="text", payload={"text": "ignored"})],
        idempotency_key="bot-2",
    )
    assert dup["idempotent"] is True
    assert dup["streamSeq"] == 2

    msgs = svc.list_messages(admin, channel_id)
    assert [m["streamSeq"] for m in msgs] == [1, 2]

    thread_id = svc.create_thread(bot, channel_id, first["messageId"])
    svc.create_grant(admin, bot_id, "thread", thread_id, "message:append")
    thread_msg = svc.append_message(
        bot,
        stream_id=thread_id,
        stream_type="thread",
        parts=[MessagePart(type="text", payload={"text": "in thread"})],
        idempotency_key="thread-1",
    )
    assert thread_msg["streamSeq"] == 1

    events = svc.subscribe(admin, channel_id, from_seq=0)
    assert [e["type"] for e in events] == ["message.appended", "message.appended"]


def test_permission_request_approval_flow_e2e(svc: MessageLayer):
    org_id = svc.create_org("Acme")
    admin_id = svc.create_actor(org_id, "human", "admin")
    user_id = svc.create_actor(org_id, "human", "user")

    admin = Principal(actor_id=admin_id, org_id=org_id, scopes=["grant:create", "channel:create"], provider="local")
    user = Principal(actor_id=user_id, org_id=org_id, scopes=[], provider="local")

    channel_id = svc.create_channel(admin, "private")

    with pytest.raises(PermissionError):
        svc.append_message(
            user,
            stream_id=channel_id,
            stream_type="channel",
            parts=[MessagePart(type="text", payload={"text": "nope"})],
            idempotency_key="u-1",
        )

    req_id = svc.create_permission_request(user, "message:append", "channel", channel_id)
    svc.resolve_permission_request(admin, req_id, approve=True)

    ok = svc.append_message(
        user,
        stream_id=channel_id,
        stream_type="channel",
        parts=[MessagePart(type="approval_response", payload={"approved": True})],
        idempotency_key="u-2",
    )
    assert ok["streamSeq"] == 1


def test_cursor_client_and_audit_hash_chain_e2e(svc: MessageLayer):
    org_id = svc.create_org("Acme")
    admin_id = svc.create_actor(org_id, "human", "admin")
    admin = Principal(actor_id=admin_id, org_id=org_id, scopes=["grant:create", "channel:create", "message:append"], provider="local")

    channel_id = svc.create_channel(admin, "ops")
    m = svc.append_message(
        admin,
        stream_id=channel_id,
        stream_type="channel",
        parts=[MessagePart(type="text", payload={"text": "check"})],
        idempotency_key="a-1",
    )
    svc.update_cursor(admin, channel_id, last_seen_seq=m["streamSeq"], last_ack_seq=m["streamSeq"])
    client_id = svc.register_client(admin, "wss://device-1", {"platform": "ios"})
    assert client_id

    rows = svc.conn.execute(
        "SELECT event_type,payload_json,prev_hash,event_hash,created_at FROM audit_events WHERE org_id=? ORDER BY created_at ASC",
        (org_id,),
    ).fetchall()
    assert len(rows) > 3

    prev_hash = ""
    for row in rows:
        expected = hashlib.sha256(
            f"{prev_hash}|{row['event_type']}|{json.dumps(json.loads(row['payload_json']), sort_keys=True)}|{row['created_at']}".encode()
        ).hexdigest()
        assert row["event_hash"] == expected
        prev_hash = row["event_hash"]
