"""Pipecat WebRTC -> 1 FPS sampler -> GeminiLiveLLMService pipeline wiring."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from google.genai.types import LiveServerMessage
from loguru import logger
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    Frame,
    FunctionCallResultProperties,
    InputTextRawFrame,
    LLMFullResponseEndFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.google.gemini_live.llm import (
    ContextWindowCompressionParams,
    GeminiLiveLLMService,
)
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from openbot_bridge.config import BridgeConfig
from openbot_bridge.contract import ActionProtocolContract, ActionRequest
from openbot_bridge.errors import SessionResumptionError
from openbot_bridge.frame_sampler import OneFpsFrameSampler
from openbot_bridge.session_store import SessionResumptionCoordinator
from openbot_bridge.tool_relay import ToolRelay

DEFAULT_SYSTEM_INSTRUCTION = (
    "You are OpenBot, an aggressive real-time RTS strategist playing OpenFront. "
    "Observe the 1 FPS game viewport stream (map + HUD) using normalized [0.0..1.0] top-left "
    "coordinates. STRICT REQUIREMENT: You MUST respond by invoking one of your declared "
    "NON_BLOCKING gameplay tools on EVERY turn; NEVER reply with spoken audio/text alone. "
    "1) SPAWN PHASE: When spawn selection ('Click to spawn' / 'Chọn vị trí bắt đầu') is shown, "
    "immediately call select_spawn on large contiguous LAND (never open ocean water). "
    "2) EARLY-GAME & ACTIVE AGGRESSION: STRONGLY DISCOURAGE wait_observe while the match is active "
    "and unclaimed land or weak neighbors are available. Set attack ratio dynamically via "
    "set_attack_ratio around 25-40% early to avoid over-extending while chaining frequent "
    "attack_territory calls across adjacent neutral territory and weaker neighbors; raise ratio to "
    "50-65% when finishing a weakened rival. "
    "3) ECONOMY SCALING: Weave in build_structure (city, port, factory, defense_post, "
    "missile_silo) once gold permits so troop cap and income snowball. "
    "4) WAIT_OBSERVE RESTRICTION: Reserve wait_observe STRICTLY for (a) critically low troop "
    "recovery (<15% troop bar) or (b) confirmed Game Over / Victory / Defeat modal — when the "
    "match is over, begin your wait_observe rationale with 'GAME_OVER:'. "
    "5) CAMERA DISCIPLINE: Use zoom_map(direction='in') when placing structures or targeting tight "
    "borders/cities, use pan_map (WASD hotkeys, never triggers accidental attacks) to scan fronts, "
    "zoom back out periodically with zoom_map(direction='out') to maintain macro map awareness, "
    "and NEVER remain zoomed into empty ocean or off-map space. "
    "Always include a concise tactical rationale in every tool call."
)

DEFAULT_TICK_PROMPT = (
    "Inspect the latest OpenFront viewport frame (map + HUD). "
    "Play aggressively: invoke the single best active gameplay tool NOW (select_spawn, "
    "attack_territory, set_attack_ratio, build_structure, zoom_map, or pan_map). "
    "Do NOT call wait_observe unless troops are critically low (<15%) or GAME_OVER is visible."
)

WATCHDOG_NUDGE_PROMPT = (
    "WATCHDOG NOTICE: Your recent turns contained zero tool calls. Spoken commentary has NO effect "
    "on the game. Invoke an active NON_BLOCKING tool NOW (attack_territory, set_attack_ratio, "
    "build_structure, zoom_map, pan_map, or select_spawn; wait_observe only if <15% troops or "
    "GAME_OVER)."
)

_TYPE_MAP = {
    "OBJECT": "object",
    "STRING": "string",
    "NUMBER": "number",
    "INTEGER": "integer",
    "BOOLEAN": "boolean",
    "ARRAY": "array",
}


def _normalize_schema_node(node: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in node.items():
        if key == "type" and isinstance(value, str):
            normalized[key] = _TYPE_MAP.get(value.upper(), value.lower())
        elif key == "properties" and isinstance(value, dict):
            normalized[key] = {
                prop_name: _normalize_schema_node(prop_schema)
                for prop_name, prop_schema in value.items()
                if isinstance(prop_schema, dict)
            }
        elif key == "items" and isinstance(value, dict):
            normalized[key] = _normalize_schema_node(value)
        else:
            normalized[key] = value
    return normalized


def build_tools_schema(contract: ActionProtocolContract) -> ToolsSchema:
    """Convert contracts/action-protocol.json declarations into a Pipecat ToolsSchema."""
    schemas: list[FunctionSchema] = []
    for decl in contract.gemini_function_declarations:
        params = _normalize_schema_node(decl.parameters)
        properties = params.get("properties", {})
        required = list(params.get("required", []))
        schemas.append(
            FunctionSchema(
                name=decl.name,
                description=decl.description,
                properties=properties,
                required=required,
            )
        )
    return ToolsSchema(standard_tools=schemas)


_FATAL_QUOTA_MARKERS = (
    "quota",
    "resource_exhausted",
    "429",
    "rate limit",
    "prepayment",
    "billing",
    "limit exceeded",
    "exceeded your current quota",
)


def _is_fatal_quota_or_rate_error(error: Exception) -> bool:
    msg = str(error).lower()
    return any(marker in msg for marker in _FATAL_QUOTA_MARKERS)


DEFAULT_POST_TURN_COOLDOWN_S = 1.2
DEFAULT_TURN_TIMEOUT_S = 10.0


class OpenBotGeminiLiveLLMService(GeminiLiveLLMService):
    """GeminiLiveLLMService extended with atomic resumption persistence and GoAway recovery."""

    def __init__(
        self,
        *,
        coordinator: SessionResumptionCoordinator,
        tool_relay: ToolRelay,
        frame_sampler: OneFpsFrameSampler,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._coordinator = coordinator
        self._tool_relay = tool_relay
        self._frame_sampler = frame_sampler
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._tool_call_listeners: list[Callable[[str], None]] = []
        self._turn_complete_listeners: list[Callable[[], None]] = []
        self._turn_interrupted_listeners: list[Callable[[], None]] = []
        self._pending_tool_calls: int = 0
        if coordinator.current_handle:
            self._session_resumption_handle = coordinator.current_handle

    def register_tool_call_listener(self, listener: Callable[[str], None]) -> None:
        if listener not in self._tool_call_listeners:
            self._tool_call_listeners.append(listener)

    def notify_tool_call(self, tool_name: str) -> None:
        for listener in self._tool_call_listeners:
            listener(tool_name)

    def register_turn_complete_listener(self, listener: Callable[[], None]) -> None:
        if listener not in self._turn_complete_listeners:
            self._turn_complete_listeners.append(listener)

    def notify_turn_complete(self) -> None:
        for listener in self._turn_complete_listeners:
            listener()

    def register_turn_interrupted_listener(self, listener: Callable[[], None]) -> None:
        if listener not in self._turn_interrupted_listeners:
            self._turn_interrupted_listeners.append(listener)

    def notify_turn_interrupted(self) -> None:
        for listener in self._turn_interrupted_listeners:
            listener()

    def mark_tool_call_started(self) -> None:
        self._pending_tool_calls += 1

    def mark_tool_call_finished(self) -> None:
        self._pending_tool_calls = max(0, self._pending_tool_calls - 1)

    async def reset_stalled_session(self) -> None:
        """Reset Gemini Live connection with a clean history when tool calling stalls."""
        logger.warning("Resetting stalled Gemini Live session cleanly (clearing handle)")
        self._session_resumption_handle = None
        self._pending_tool_calls = 0
        self.notify_turn_interrupted()
        context = getattr(self, "_context", None)
        if context is not None and hasattr(context, "set_messages"):
            context.set_messages([])
        try:
            self._coordinator.store.clear()
            _ = self._coordinator.on_disconnect()
        except SessionResumptionError as exc:
            logger.warning(f"Ignoring coordinator state error during stall reset: {exc}")
        await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())
        await self._reconnect()  # type: ignore[no-untyped-call]

    @property
    def is_ready_for_turn(self) -> bool:
        """Whether the Gemini Live session is connected and idle for a tactical prompt."""
        return bool(
            getattr(self, "_ready_for_realtime_input", False)
            and not getattr(self, "_disconnecting", False)
            and not getattr(self, "_bot_is_responding", False)
            and self._pending_tool_calls == 0
        )

    async def push_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        await super().push_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMFullResponseEndFrame):
            self.notify_turn_complete()

    async def _handle_msg_turn_complete(self, message: LiveServerMessage) -> None:
        await super()._handle_msg_turn_complete(message)
        self.notify_turn_complete()

    def _schedule_status_broadcast(self) -> None:
        status = self._coordinator.to_session_status()
        try:
            loop = asyncio.get_running_loop()
            task = loop.create_task(self._tool_relay.broadcast_session_status(status))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
        except RuntimeError:
            pass

    def _handle_msg_resumption_update(self, message: LiveServerMessage) -> None:
        super()._handle_msg_resumption_update(message)
        update = message.session_resumption_update
        if update is None:
            return
        try:
            self._coordinator.on_resumption_update(
                handle=update.new_handle,
                resumable=bool(update.resumable),
            )
        except SessionResumptionError as exc:
            logger.error(f"Failed to persist session resumption handle: {exc}")

    async def _handle_server_message(self, message: LiveServerMessage) -> None:
        await super()._handle_server_message(message)
        sc = getattr(message, "server_content", None)
        if sc is not None and getattr(sc, "interrupted", False):
            self.notify_turn_interrupted()
        go_away = getattr(message, "go_away", None)
        if go_away is not None:
            raw_time_left = getattr(go_away, "time_left", None)
            logger.warning(f"Gemini Live GoAway received (time_left={raw_time_left!r})")
            try:
                _ = self._coordinator.on_go_away()
            except SessionResumptionError as exc:
                await self.push_error(
                    error_msg=str(exc),
                    exception=exc,
                    force_treat_as_permanent=True,
                )
                return
            await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())
            await self._reconnect()  # type: ignore[no-untyped-call]

    async def _handle_session_ready(self, session: Any) -> None:
        was_resumed = self._session_resumption_handle is not None
        await super()._handle_session_ready(session)
        if was_resumed and self._coordinator.state in ("go_away", "reconnecting"):
            self._coordinator.mark_resumed()
        else:
            self._coordinator.mark_connected()
        await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())

    async def _handle_connection_error(self, error: Exception) -> bool:
        self._pending_tool_calls = 0
        self.notify_turn_interrupted()
        if _is_fatal_quota_or_rate_error(error):
            logger.error(
                f"Gemini Live fatal quota/rate limit reached (stopping without retry): {error}"
            )
            self._coordinator.mark_error()
            await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())
            await self.push_error(
                error_msg=str(error),
                exception=error,
                force_treat_as_permanent=True,
            )
            return False
        try:
            _ = self._coordinator.on_disconnect()
        except SessionResumptionError as exc:
            await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())
            await self.push_error(
                error_msg=str(exc),
                exception=exc,
                force_treat_as_permanent=True,
            )
            return False
        await self._tool_relay.broadcast_session_status(self._coordinator.to_session_status())
        return await super()._handle_connection_error(error)

    async def _disconnect(self) -> None:
        self._pending_tool_calls = 0
        self.notify_turn_interrupted()
        await super()._disconnect()  # type: ignore[no-untyped-call]
        if self._coordinator.state not in ("go_away", "reconnecting"):
            self._coordinator.mark_closed()
            self._schedule_status_broadcast()


class TacticalDecisionTicker:
    """Queues turn-gated InputTextRawFrame prompts when Gemini is idle and a frame is fresh."""

    def __init__(
        self,
        *,
        frame_sampler: OneFpsFrameSampler,
        llm_service: OpenBotGeminiLiveLLMService,
        queue_frame_fn: Callable[[Frame], Awaitable[None]],
        interval_s: float = 2.0,
        post_turn_cooldown_s: float = DEFAULT_POST_TURN_COOLDOWN_S,
        turn_timeout_s: float = DEFAULT_TURN_TIMEOUT_S,
        clock_fn: Callable[[], float] = time.monotonic,
        prompt_text: str = DEFAULT_TICK_PROMPT,
        nudge_prompt_text: str = WATCHDOG_NUDGE_PROMPT,
        stall_nudge_threshold: int = 6,
        stall_reset_threshold: int = 18,
        on_stall_reset: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        if interval_s <= 0:
            raise ValueError(f"interval_s must be > 0, got {interval_s}")
        if post_turn_cooldown_s < 0:
            raise ValueError(f"post_turn_cooldown_s must be >= 0, got {post_turn_cooldown_s}")
        if turn_timeout_s <= 0:
            raise ValueError(f"turn_timeout_s must be > 0, got {turn_timeout_s}")
        if stall_nudge_threshold < 1 or stall_reset_threshold <= stall_nudge_threshold:
            raise ValueError("Invalid watchdog stall thresholds")
        self._frame_sampler = frame_sampler
        self._llm_service = llm_service
        self._queue_frame_fn = queue_frame_fn
        self._clock_fn = clock_fn
        self.interval_s = interval_s
        self.post_turn_cooldown_s = post_turn_cooldown_s
        self.turn_timeout_s = turn_timeout_s
        self.prompt_text = prompt_text
        self.nudge_prompt_text = nudge_prompt_text
        self.stall_nudge_threshold = stall_nudge_threshold
        self.stall_reset_threshold = stall_reset_threshold
        self._on_stall_reset = on_stall_reset
        self._last_prompted_frame_ts: float | None = None
        self._turn_in_flight = False
        self._turn_started_at: float | None = None
        self._turn_had_tool_call = False
        self._last_turn_completed_at: float | None = None
        self.ticks_sent = 0
        self.turns_completed = 0
        self.turn_timeouts = 0
        self.consecutive_empty_ticks = 0
        self.tool_calls_observed = 0
        self.watchdog_nudges_sent = 0
        self.watchdog_resets_sent = 0
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

        llm_service.register_tool_call_listener(self.record_tool_call)
        llm_service.register_turn_complete_listener(self.record_turn_complete)
        llm_service.register_turn_interrupted_listener(self.record_turn_interrupted)

    @property
    def turn_in_flight(self) -> bool:
        """Whether a decision turn has been emitted and is still awaiting completion."""
        return self._turn_in_flight

    def record_tool_call(self, _tool_name: str = "") -> None:
        """Mark active turn as productive and reset consecutive-empty-turn counter."""
        self._turn_had_tool_call = True
        self.consecutive_empty_ticks = 0
        self.tool_calls_observed += 1

    def record_turn_complete(self) -> None:
        """Release the in-flight turn lock on model turn completion and update watchdog state."""
        if not self._turn_in_flight:
            return
        now = self._clock_fn()
        had_tool = self._turn_had_tool_call
        self._turn_in_flight = False
        self._turn_started_at = None
        self._turn_had_tool_call = False
        self._last_turn_completed_at = now
        self.turns_completed += 1
        if had_tool:
            self.consecutive_empty_ticks = 0
        else:
            self.consecutive_empty_ticks += 1

    def record_turn_interrupted(self) -> None:
        """Release the in-flight lock if the session interrupted or disconnected mid-turn."""
        if not self._turn_in_flight:
            return
        self._turn_in_flight = False
        self._turn_started_at = None
        self._turn_had_tool_call = False
        self._last_turn_completed_at = self._clock_fn()

    async def tick_once(self) -> bool:
        """Emit one tactical prompt when idle, post-turn cooldown passed, and frame is fresh."""
        now = self._clock_fn()

        if self._turn_in_flight:
            started_at = self._turn_started_at if self._turn_started_at is not None else now
            elapsed = now - started_at
            if elapsed < self.turn_timeout_s:
                return False
            logger.warning(
                f"Watchdog: turn #{self.ticks_sent} timed out after {elapsed:.1f}s "
                f"without turn_complete; releasing in-flight lock"
            )
            had_tool = self._turn_had_tool_call
            self._turn_in_flight = False
            self._turn_started_at = None
            self._turn_had_tool_call = False
            self.turn_timeouts += 1
            if not had_tool:
                self.consecutive_empty_ticks += 1

        if (
            self._last_turn_completed_at is not None
            and (now - self._last_turn_completed_at) < self.post_turn_cooldown_s
        ):
            return False

        last_ts = self._frame_sampler.last_frame_captured_at_ms
        if last_ts is None:
            return False
        if self._last_prompted_frame_ts is not None and last_ts <= self._last_prompted_frame_ts:
            return False
        if not self._llm_service.is_ready_for_turn:
            return False

        if self.consecutive_empty_ticks >= self.stall_reset_threshold and self._on_stall_reset:
            logger.warning(
                f"Watchdog: {self.consecutive_empty_ticks} completed empty turns "
                "without tool calls; resetting Gemini Live session"
            )
            self._last_prompted_frame_ts = last_ts
            self.consecutive_empty_ticks = 0
            self._turn_in_flight = False
            self._turn_started_at = None
            self._turn_had_tool_call = False
            self._last_turn_completed_at = now
            self.watchdog_resets_sent += 1
            await self._on_stall_reset()
            return True

        if self.consecutive_empty_ticks >= self.stall_nudge_threshold:
            prompt = self.nudge_prompt_text
            self.watchdog_nudges_sent += 1
            logger.warning(
                f"Watchdog nudge #{self.watchdog_nudges_sent} after "
                f"{self.consecutive_empty_ticks} completed empty turns"
            )
        else:
            prompt = self.prompt_text

        self._last_prompted_frame_ts = last_ts
        self._turn_in_flight = True
        self._turn_started_at = now
        self._turn_had_tool_call = False
        self.ticks_sent += 1
        logger.info(
            f"TacticalDecisionTicker emitting turn #{self.ticks_sent} (frame_ts={last_ts:.0f})"
        )
        try:
            await self._queue_frame_fn(InputTextRawFrame(text=prompt))
        except Exception:
            self._turn_in_flight = False
            self._turn_started_at = None
            raise
        return True

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            emitted = False
            try:
                emitted = await self.tick_once()
            except Exception as exc:
                logger.warning(f"TacticalDecisionTicker error: {exc}")
            sleep_s = self.interval_s if emitted else min(self.interval_s, 0.25)
            with suppress(TimeoutError):
                await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_s)


def _make_non_blocking_tool_handler(
    *,
    tool_name: str,
    coordinator: SessionResumptionCoordinator,
    tool_relay: ToolRelay,
    frame_sampler: OneFpsFrameSampler,
    on_tool_call: Callable[[str], None] | None = None,
    on_tool_start: Callable[[], None] | None = None,
    on_tool_finish: Callable[[], None] | None = None,
) -> Callable[[FunctionCallParams], Awaitable[None]]:
    async def _handle_tool_call(params: FunctionCallParams) -> None:
        logger.info(f"Gemini tool call received: {tool_name} call_id={params.tool_call_id}")
        if on_tool_start is not None:
            on_tool_start()
        try:
            if on_tool_call is not None:
                on_tool_call(tool_name)
            now_ms = time.time() * 1000.0
            captured_ms = (
                frame_sampler.last_frame_captured_at_ms
                if frame_sampler.last_frame_captured_at_ms is not None
                else now_ms
            )
            request = ActionRequest(
                call_id=params.tool_call_id,
                session_id=coordinator.session_id,
                tool_name=tool_name,
                arguments=dict(params.arguments),
                frame_captured_at_ms=captured_ms,
                model_emitted_at_ms=now_ms,
            )
            response = await tool_relay.dispatch_action(request)
            run_llm = response.scheduling != "SILENT"
            await params.result_callback(
                response.model_dump(mode="json"),
                properties=FunctionCallResultProperties(run_llm=run_llm),
            )
        finally:
            if on_tool_finish is not None:
                on_tool_finish()

    return _handle_tool_call


def build_gemini_service(
    *,
    config: BridgeConfig,
    contract: ActionProtocolContract,
    coordinator: SessionResumptionCoordinator,
    tool_relay: ToolRelay,
    frame_sampler: OneFpsFrameSampler,
    tools_schema: ToolsSchema | None = None,
    system_instruction: str = DEFAULT_SYSTEM_INSTRUCTION,
) -> OpenBotGeminiLiveLLMService:
    """Create and configure OpenBotGeminiLiveLLMService with all contract NON_BLOCKING tools."""
    resolved_tools = tools_schema or build_tools_schema(contract)
    settings = GeminiLiveLLMService.Settings(
        model=config.gemini_live_model,
        system_instruction=system_instruction,
        context_window_compression=ContextWindowCompressionParams(enabled=True),
    )
    service = OpenBotGeminiLiveLLMService(
        api_key=config.gemini_api_key,
        tools=resolved_tools,
        settings=settings,
        coordinator=coordinator,
        tool_relay=tool_relay,
        frame_sampler=frame_sampler,
        start_audio_paused=True,
        inference_on_context_initialization=False,
        http_options={"api_version": "v1alpha"},
    )

    for decl in contract.gemini_function_declarations:
        handler = _make_non_blocking_tool_handler(
            tool_name=decl.name,
            coordinator=coordinator,
            tool_relay=tool_relay,
            frame_sampler=frame_sampler,
            on_tool_call=service.notify_tool_call,
            on_tool_start=service.mark_tool_call_started,
            on_tool_finish=service.mark_tool_call_finished,
        )
        service.register_function(
            decl.name,
            handler,
            cancel_on_interruption=False,
            timeout_secs=config.tool_timeout_s + 2.0,
        )

    return service


@dataclass
class BridgePipelineBundle:
    """Assembled Pipecat WebRTC -> 1 FPS sampler -> Gemini Live pipeline components."""

    connection: SmallWebRTCConnection
    transport: SmallWebRTCTransport
    frame_sampler: OneFpsFrameSampler
    llm_service: OpenBotGeminiLiveLLMService
    context: LLMContext
    tools_schema: ToolsSchema
    pipeline: Pipeline

    async def disable_webrtc_video_in(self) -> None:
        """Disable unused WebRTC inbound video pulling when running in /ws/capture-frames mode."""
        self.transport._params.video_in_enabled = False
        input_transport = self.transport.input()
        input_transport._params.video_in_enabled = False
        for attr in ("_receive_video_task", "_receive_screen_video_task"):
            recv_task = getattr(input_transport, attr, None)
            if recv_task is None:
                continue
            setattr(input_transport, attr, None)
            if getattr(input_transport, "_task_manager", None) is not None:
                await input_transport.cancel_task(recv_task)
            else:
                recv_task.cancel()
                with suppress(asyncio.CancelledError):
                    await recv_task


def build_bridge_pipeline(
    *,
    config: BridgeConfig,
    contract: ActionProtocolContract,
    coordinator: SessionResumptionCoordinator,
    tool_relay: ToolRelay,
    ice_servers: list[str] | list[IceServer] | None = None,
    system_instruction: str = DEFAULT_SYSTEM_INSTRUCTION,
) -> BridgePipelineBundle:
    """Wire SmallWebRTCTransport -> OneFpsFrameSampler -> OpenBotGeminiLiveLLMService."""
    connection = SmallWebRTCConnection(ice_servers=ice_servers)
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            video_in_enabled=True,
            audio_in_enabled=False,
            audio_out_enabled=False,
            video_out_enabled=False,
        ),
    )
    frame_sampler = OneFpsFrameSampler(
        max_fps=config.max_fps,
        debug_frame_path=config.debug_frame_path,
    )
    tools_schema = build_tools_schema(contract)
    llm_service = build_gemini_service(
        config=config,
        contract=contract,
        coordinator=coordinator,
        tool_relay=tool_relay,
        frame_sampler=frame_sampler,
        tools_schema=tools_schema,
        system_instruction=system_instruction,
    )
    context = LLMContext(messages=[])
    context_aggregator = LLMContextAggregatorPair(context, realtime_service_mode=True)
    pipeline = Pipeline(
        [
            transport.input(),
            frame_sampler,
            context_aggregator.user(),
            llm_service,
            context_aggregator.assistant(),
        ]
    )
    return BridgePipelineBundle(
        connection=connection,
        transport=transport,
        frame_sampler=frame_sampler,
        llm_service=llm_service,
        context=context,
        tools_schema=tools_schema,
        pipeline=pipeline,
    )
