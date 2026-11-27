"""Localhost /ws/actions WebSocket hub correlating ActionRequest, ActionResponse, and HUD."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any, Protocol

from pydantic import ValidationError

from openbot_bridge.contract import (
    ActionRequest,
    ActionResponse,
    HudSnapshot,
    PingPong,
    RecoveryPayload,
    SessionStatus,
)
from openbot_bridge.errors import ToolRelayError


class WebSocketPeer(Protocol):
    """Minimal async WebSocket peer protocol compatible with FastAPI WebSocket."""

    async def send_text(self, data: str) -> None: ...


class ToolRelay:
    """Correlates NON_BLOCKING tool calls and HUD snapshots with TS orchestrator /ws/actions."""

    def __init__(self, *, default_timeout_s: float = 10.0) -> None:
        if default_timeout_s <= 0:
            raise ToolRelayError("default_timeout_s must be > 0")
        self.default_timeout_s = default_timeout_s
        self._clients: list[WebSocketPeer] = []
        self._pending: dict[str, asyncio.Future[ActionResponse]] = {}
        self._lock = asyncio.Lock()
        self.latest_hud: HudSnapshot | None = None
        self._hud_listeners: list[Callable[[HudSnapshot], None]] = []

    @property
    def has_client(self) -> bool:
        return len(self._clients) > 0

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def register_hud_listener(self, listener: Callable[[HudSnapshot], None]) -> None:
        if listener not in self._hud_listeners:
            self._hud_listeners.append(listener)

    async def register_client(self, client: WebSocketPeer) -> None:
        async with self._lock:
            if client not in self._clients:
                self._clients.append(client)

    async def unregister_client(self, client: WebSocketPeer) -> None:
        async with self._lock:
            if client in self._clients:
                self._clients.remove(client)
            has_clients = len(self._clients) > 0

        if not has_clients:
            self._fail_pending_on_disconnect("Orchestrator WebSocket disconnected")

    def _fail_pending_on_disconnect(self, reason: str) -> None:
        for call_id, future in list(self._pending.items()):
            if not future.done():
                future.set_result(
                    self._build_error_response(
                        call_id=call_id,
                        summary=reason,
                        root_cause=reason,
                        safe_retry=(
                            "Wait for orchestrator WebSocket reconnect then call wait_observe."
                        ),
                        stop_condition=(
                            "Abort if /ws/actions remains disconnected for > 15 seconds."
                        ),
                        latency_ms=0.0,
                    )
                )
            self._pending.pop(call_id, None)

    @staticmethod
    def _build_error_response(
        *,
        call_id: str,
        summary: str,
        root_cause: str,
        safe_retry: str,
        stop_condition: str,
        latency_ms: float,
    ) -> ActionResponse:
        return ActionResponse(
            call_id=call_id,
            status="error",
            summary=summary,
            next_actions=["wait_observe"],
            artifacts={},
            latency_ms=max(0.0, latency_ms),
            scheduling="WHEN_IDLE",
            recovery=RecoveryPayload(
                root_cause=root_cause,
                safe_retry=safe_retry,
                stop_condition=stop_condition,
            ),
        )

    async def dispatch_action(
        self,
        request: ActionRequest,
        *,
        timeout_s: float | None = None,
    ) -> ActionResponse:
        """Send ActionRequest to active orchestrator client and await correlated ActionResponse."""
        started = time.monotonic()
        effective_timeout = timeout_s if timeout_s is not None else self.default_timeout_s

        async with self._lock:
            client = self._clients[-1] if self._clients else None
            if client is None:
                return self._build_error_response(
                    call_id=request.call_id,
                    summary="No orchestrator WebSocket client connected on /ws/actions",
                    root_cause="No orchestrator WebSocket client connected",
                    safe_retry="Hold actions using wait_observe until orchestrator connects.",
                    stop_condition="Stop match loop if orchestrator does not connect within 15s.",
                    latency_ms=0.0,
                )

            loop = asyncio.get_running_loop()
            future: asyncio.Future[ActionResponse] = loop.create_future()
            self._pending[request.call_id] = future

        try:
            await client.send_text(request.model_dump_json())
            response = await asyncio.wait_for(future, timeout=effective_timeout)
            return response
        except TimeoutError:
            elapsed_ms = (time.monotonic() - started) * 1000.0
            return self._build_error_response(
                call_id=request.call_id,
                summary=f"Action {request.tool_name} timed out after {effective_timeout:.2f}s",
                root_cause=f"Action response timeout after {effective_timeout:.2f}s",
                safe_retry="Re-observe board state with wait_observe before retrying action.",
                stop_condition="Stop retrying if 3 consecutive tool calls time out.",
                latency_ms=elapsed_ms,
            )
        except Exception as exc:
            elapsed_ms = (time.monotonic() - started) * 1000.0
            return self._build_error_response(
                call_id=request.call_id,
                summary=f"Action {request.tool_name} failed to send over /ws/actions",
                root_cause=f"WebSocket dispatch error: {exc}",
                safe_retry="Wait briefly with wait_observe and verify orchestrator connection.",
                stop_condition="Stop if WebSocket errors repeat across 3 actions.",
                latency_ms=elapsed_ms,
            )
        finally:
            self._pending.pop(request.call_id, None)

    async def handle_incoming_message(self, raw_text: str) -> None:
        """Parse inbound /ws/actions JSON message (ActionResponse, HudSnapshot, or PingPong)."""
        try:
            payload: Any = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise ToolRelayError(f"Malformed JSON on /ws/actions: {exc}") from exc

        if not isinstance(payload, dict) or "type" not in payload:
            raise ToolRelayError("Inbound /ws/actions message must be a JSON object with 'type'")

        msg_type = payload.get("type")
        if msg_type == "action_response":
            try:
                response = ActionResponse.model_validate(payload)
            except ValidationError as exc:
                raise ToolRelayError(f"Invalid action_response payload: {exc}") from exc
            future = self._pending.get(response.call_id)
            if future is not None and not future.done():
                future.set_result(response)
            return

        if msg_type == "hud_snapshot":
            try:
                hud = HudSnapshot.model_validate(payload)
            except ValidationError as exc:
                raise ToolRelayError(f"Invalid hud_snapshot payload: {exc}") from exc
            self.latest_hud = hud
            for listener in list(self._hud_listeners):
                listener(hud)
            return

        if msg_type == "ping":
            try:
                ping = PingPong.model_validate(payload)
            except ValidationError as exc:
                raise ToolRelayError(f"Invalid ping payload: {exc}") from exc
            pong = PingPong(type="pong", timestamp_ms=ping.timestamp_ms)
            await self._broadcast_text(pong.model_dump_json())
            return

        if msg_type == "pong":
            return

        raise ToolRelayError(f"Unsupported inbound /ws/actions message type: {msg_type!r}")

    async def broadcast_session_status(self, status: SessionStatus) -> None:
        """Broadcast SessionStatus update to all connected orchestrator clients."""
        await self._broadcast_text(status.model_dump_json())

    async def _broadcast_text(self, text: str) -> None:
        async with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                await client.send_text(text)
            except Exception:
                await self.unregister_client(client)
