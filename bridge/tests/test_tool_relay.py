"""TDD tests for ToolRelay localhost WebSocket hub and call_id correlation."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from openbot_bridge.contract import ActionRequest, ActionResponse, SessionStatus
from openbot_bridge.tool_relay import ToolRelay


class FakeWebSocket:
    """In-memory WebSocket peer stub for testing ToolRelay without sockets."""

    def __init__(self) -> None:
        self.sent_messages: list[dict[str, Any]] = []
        self.closed = False

    async def send_text(self, data: str) -> None:
        self.sent_messages.append(json.loads(data))


@pytest.mark.asyncio
async def test_tool_relay_correlates_action_request_and_response() -> None:
    relay = ToolRelay(default_timeout_s=1.0)
    ws = FakeWebSocket()
    await relay.register_client(ws)

    request = ActionRequest(
        call_id="call-42",
        session_id="sess-1",
        tool_name="attack_territory",
        arguments={"x": 0.4, "y": 0.6, "rationale": "expand"},
        frame_captured_at_ms=100.0,
        model_emitted_at_ms=120.0,
    )

    async def simulate_orchestrator_reply() -> None:
        await asyncio.sleep(0.01)
        assert len(ws.sent_messages) == 1
        outbound = ws.sent_messages[0]
        assert outbound["type"] == "action_request"
        assert outbound["call_id"] == "call-42"

        reply = ActionResponse(
            call_id="call-42",
            status="success",
            summary="Attacked target (0.40, 0.60)",
            next_actions=["wait_observe"],
            artifacts={"ratio_pct": 50},
            latency_ms=18.5,
            scheduling="WHEN_IDLE",
        )
        await relay.handle_incoming_message(reply.model_dump_json())

    task = asyncio.create_task(simulate_orchestrator_reply())
    response = await relay.dispatch_action(request)
    await task

    assert response.status == "success"
    assert response.call_id == "call-42"
    assert response.scheduling == "WHEN_IDLE"


@pytest.mark.asyncio
async def test_tool_relay_returns_structured_recovery_on_timeout() -> None:
    relay = ToolRelay(default_timeout_s=0.05)
    ws = FakeWebSocket()
    await relay.register_client(ws)

    request = ActionRequest(
        call_id="call-timeout",
        session_id="sess-1",
        tool_name="build_structure",
        arguments={"structure": "city", "x": 0.2, "y": 0.3, "rationale": "eco"},
        frame_captured_at_ms=100.0,
        model_emitted_at_ms=120.0,
    )

    response = await relay.dispatch_action(request)
    assert response.call_id == "call-timeout"
    assert response.status == "error"
    assert response.scheduling == "WHEN_IDLE"
    assert response.recovery is not None
    assert "timeout" in response.recovery.root_cause.lower()


@pytest.mark.asyncio
async def test_tool_relay_returns_structured_recovery_when_no_client_connected() -> None:
    relay = ToolRelay(default_timeout_s=0.5)
    request = ActionRequest(
        call_id="call-no-client",
        session_id="sess-1",
        tool_name="wait_observe",
        arguments={"duration_ms": 1000, "rationale": "wait"},
        frame_captured_at_ms=100.0,
        model_emitted_at_ms=120.0,
    )

    response = await relay.dispatch_action(request)
    assert response.status == "error"
    assert response.recovery is not None
    assert "connected" in response.recovery.root_cause.lower()


@pytest.mark.asyncio
async def test_tool_relay_responds_to_ping_and_broadcasts_session_status() -> None:
    relay = ToolRelay(default_timeout_s=0.5)
    ws = FakeWebSocket()
    await relay.register_client(ws)

    await relay.handle_incoming_message(json.dumps({"type": "ping", "timestamp_ms": 555.0}))
    assert ws.sent_messages[-1] == {"type": "pong", "timestamp_ms": 555.0}

    status = SessionStatus(
        session_id="sess-1",
        state="connected",
        resumption_handle_present=False,
        timestamp_ms=777.0,
    )
    await relay.broadcast_session_status(status)
    assert ws.sent_messages[-1]["type"] == "session_status"
    assert ws.sent_messages[-1]["state"] == "connected"
