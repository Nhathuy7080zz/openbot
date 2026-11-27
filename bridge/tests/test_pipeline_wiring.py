"""TDD tests for Pipecat pipeline wiring, GeminiLiveLLMService resumption, and FastAPI server."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.services.google.gemini_live.llm import ContextWindowCompressionParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from openbot_bridge.config import BridgeConfig
from openbot_bridge.contract import ActionResponse, load_action_contract
from openbot_bridge.frame_sampler import OneFpsFrameSampler
from openbot_bridge.gemini_live import (
    OpenBotGeminiLiveLLMService,
    TacticalDecisionTicker,
    build_bridge_pipeline,
    build_gemini_service,
    build_tools_schema,
)
from openbot_bridge.server import create_app
from openbot_bridge.session_store import (
    SessionResumptionCoordinator,
    SessionResumptionRecord,
    SessionStore,
)
from openbot_bridge.tool_relay import ToolRelay


def _test_config(tmp_path: Path) -> BridgeConfig:
    return BridgeConfig(
        gemini_api_key="test-fake-key-never-called",
        gemini_live_model="gemini-2.5-flash-native-audio-preview-12-2025",
        bridge_host="127.0.0.1",
        bridge_port=8765,
        session_store_path=tmp_path / "session.json",
        max_fps=1.0,
        tool_timeout_s=1.0,
    )


def test_build_gemini_service_configures_compression_resumption_and_eight_non_blocking_tools(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    store.save(
        SessionResumptionRecord(
            session_id="sess-test",
            handle="persisted-handle-999",
            resumable=True,
            updated_at_ms=100.0,
        )
    )
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-test")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0, wall_ms_fn=lambda: 4242.0)
    contract = load_action_contract()

    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    assert isinstance(service, OpenBotGeminiLiveLLMService)
    assert service._session_resumption_handle == "persisted-handle-999"
    assert isinstance(service._http_options, dict)
    assert service._http_options.get("api_version") == "v1alpha"

    cwc = service._settings.context_window_compression
    assert isinstance(cwc, (ContextWindowCompressionParams, dict))
    if isinstance(cwc, ContextWindowCompressionParams):
        assert cwc.enabled is True
    else:
        assert cwc.get("enabled") is True

    assert isinstance(service._tools_from_init, ToolsSchema)
    assert len(service._tools_from_init.standard_tools) == 14
    for decl in contract.gemini_function_declarations:
        assert service._function_is_async(decl.name) is True

    adapter = service.get_llm_adapter()
    provider_tools = adapter.from_standard_tools(service._tools_from_init)
    assert isinstance(provider_tools, list)
    service._tag_tool_behaviors(provider_tools)
    decls = provider_tools[0]["function_declarations"]
    assert len(decls) == 14
    assert all(d.get("behavior") == "NON_BLOCKING" for d in decls)


@pytest.mark.asyncio
async def test_gemini_service_persists_resumption_update_and_handles_go_away(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-goaway")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0, wall_ms_fn=lambda: 5000.0)
    contract = load_action_contract()

    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    class PeerSpy:
        def __init__(self) -> None:
            self.messages: list[dict[str, Any]] = []

        async def send_text(self, data: str) -> None:
            self.messages.append(json.loads(data))

    peer = PeerSpy()
    await relay.register_client(peer)

    msg_update = SimpleNamespace(
        server_content=None,
        tool_call=None,
        usage_metadata=None,
        go_away=None,
        session_resumption_update=SimpleNamespace(resumable=True, new_handle="new-handle-xyz"),
    )
    await service._handle_server_message(msg_update)  # type: ignore[arg-type]
    assert coordinator.current_handle == "new-handle-xyz"
    reloaded = store.load()
    assert reloaded is not None
    assert reloaded.handle == "new-handle-xyz"

    reconnect_mock = AsyncMock()
    service._reconnect = reconnect_mock  # type: ignore[method-assign]

    msg_go_away = SimpleNamespace(
        server_content=None,
        tool_call=None,
        usage_metadata=None,
        session_resumption_update=None,
        go_away=SimpleNamespace(time_left="2s"),
    )
    await service._handle_server_message(msg_go_away)  # type: ignore[arg-type]
    assert coordinator.state == "go_away"
    reconnect_mock.assert_awaited_once()
    assert any(
        m.get("type") == "session_status" and m.get("state") == "go_away" for m in peer.messages
    )


@pytest.mark.asyncio
async def test_non_blocking_tool_callback_relays_action_and_passes_scheduling(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-tools")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0, wall_ms_fn=lambda: 9876.0)
    sampler.last_frame_captured_at_ms = 9876.0
    contract = load_action_contract()

    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    class OrchestratorStub:
        def __init__(self) -> None:
            self.received: list[dict[str, Any]] = []

        async def send_text(self, data: str) -> None:
            payload = json.loads(data)
            self.received.append(payload)
            if payload.get("type") == "action_request":
                reply = ActionResponse(
                    call_id=payload["call_id"],
                    status="success",
                    summary="Spawn selected",
                    next_actions=["wait_observe"],
                    artifacts={"x": 0.5, "y": 0.5},
                    latency_ms=12.0,
                    scheduling="SILENT",
                )
                await relay.handle_incoming_message(reply.model_dump_json())

    orch = OrchestratorStub()
    await relay.register_client(orch)

    callback_results: list[tuple[Any, Any]] = []

    async def result_cb(result: Any, *, properties: Any = None) -> None:
        callback_results.append((result, properties))

    handler_entry = service._functions["select_spawn"]
    params = SimpleNamespace(
        function_name="select_spawn",
        tool_call_id="gemini-call-1",
        arguments={"x": 0.5, "y": 0.5, "rationale": "center coast"},
        result_callback=result_cb,
    )
    await handler_entry.handler(params)

    assert len(orch.received) == 1
    req = orch.received[0]
    assert req["type"] == "action_request"
    assert req["tool_name"] == "select_spawn"
    assert req["frame_captured_at_ms"] == 9876.0

    assert len(callback_results) == 1
    result_dict, props = callback_results[0]
    assert result_dict["status"] == "success"
    assert props.run_llm is False


@pytest.mark.asyncio
async def test_build_bridge_pipeline_wires_webrtc_sampler_and_gemini(tmp_path: Path) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-pipe")
    relay = ToolRelay(default_timeout_s=1.0)
    contract = load_action_contract()

    bundle = build_bridge_pipeline(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        ice_servers=[],
    )

    assert isinstance(bundle.transport, SmallWebRTCTransport)
    assert bundle.transport._params.video_in_enabled is True
    assert isinstance(bundle.frame_sampler, OneFpsFrameSampler)
    assert isinstance(bundle.llm_service, OpenBotGeminiLiveLLMService)
    assert bundle.context.messages == []
    assert len(bundle.tools_schema.standard_tools) == 14
    assert bundle.pipeline is not None
    await bundle.connection.disconnect()


def test_fastapi_health_ws_actions_and_mocked_webrtc_offer(tmp_path: Path) -> None:
    cfg = _test_config(tmp_path)
    fake_answer = {"sdp": "v=0\r\nfake-answer", "type": "answer", "pc_id": "pc-mock-1"}

    async def fake_offer_handler(sdp: str, offer_type: str, pc_id: str | None) -> dict[str, str]:
        assert sdp == "v=0\r\nfake-offer"
        assert offer_type == "offer"
        assert pc_id is None
        return fake_answer

    app = create_app(config=cfg, webrtc_offer_handler=fake_offer_handler)
    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["host"] == "127.0.0.1"
    assert body["contract_version"] == "2.1.0"
    assert body["resumption_count"] == 0

    cap_page = client.get("/capture-client")
    assert cap_page.status_code == 200
    assert "RTCPeerConnection" in cap_page.text
    assert "addTransceiver('audio'" in cap_page.text
    assert "requestFrame" in cap_page.text

    offer_resp = client.post("/webrtc/offer", json={"sdp": "v=0\r\nfake-offer", "type": "offer"})
    assert offer_resp.status_code == 200
    assert offer_resp.json() == fake_answer

    with client.websocket_connect("/ws/actions") as ws:
        initial = json.loads(ws.receive_text())
        assert initial["type"] == "session_status"
        ws.send_text(json.dumps({"type": "ping", "timestamp_ms": 1234.0}))
        pong = json.loads(ws.receive_text())
        assert pong == {"type": "pong", "timestamp_ms": 1234.0}


def test_fastapi_webrtc_offer_requires_api_key(tmp_path: Path) -> None:
    cfg = BridgeConfig(
        gemini_api_key="",
        session_store_path=tmp_path / "session.json",
    )
    app = create_app(config=cfg)
    client = TestClient(app)

    resp = client.post("/webrtc/offer", json={"sdp": "v=0\r\nfake-offer", "type": "offer"})
    assert resp.status_code == 503
    assert "GEMINI_API_KEY" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_tactical_decision_ticker_emits_only_on_fresh_frame_when_ready(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-ticker")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0)
    contract = load_action_contract()
    tools = build_tools_schema(contract)
    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
        tools_schema=tools,
    )

    fake_now = 100.0
    queued: list[object] = []

    async def fake_queue(frame: object) -> None:
        queued.append(frame)

    ticker = TacticalDecisionTicker(
        frame_sampler=sampler,
        llm_service=service,
        queue_frame_fn=fake_queue,
        interval_s=0.1,
        post_turn_cooldown_s=1.2,
        turn_timeout_s=10.0,
        clock_fn=lambda: fake_now,
    )

    # No frame yet -> nothing emitted
    assert await ticker.tick_once() is False

    # Frame present, but Gemini not ready -> nothing emitted
    sampler.last_frame_captured_at_ms = 1000.0
    assert await ticker.tick_once() is False

    # Gemini ready + fresh frame -> emits turn #1 and locks in-flight state
    service._ready_for_realtime_input = True
    service._disconnecting = False
    service._bot_is_responding = False
    assert await ticker.tick_once() is True
    assert len(queued) == 1
    assert ticker.turn_in_flight is True

    # Fresh frame arrives 2.0s later while turn #1 is STILL in-flight -> MUST NOT self-interrupt
    fake_now += 2.0
    sampler.last_frame_captured_at_ms = 2000.0
    assert await ticker.tick_once() is False
    assert len(queued) == 1
    assert ticker.consecutive_empty_ticks == 0

    # Complete turn #1 -> cooldown (1.2s) blocks immediate tick, then allows turn #2 after cooldown
    msg_complete = SimpleNamespace(
        server_content=SimpleNamespace(
            interrupted=False,
            model_turn=None,
            input_transcription=None,
            output_transcription=None,
            grounding_metadata=None,
            turn_complete=True,
        ),
        tool_call=None,
        usage_metadata=None,
        session_resumption_update=None,
        go_away=None,
    )
    await service._handle_server_message(msg_complete)  # type: ignore[arg-type]
    assert ticker.turn_in_flight is False
    assert ticker.consecutive_empty_ticks == 1

    fake_now += 0.5  # < 1.2s post-turn cooldown
    assert await ticker.tick_once() is False
    assert len(queued) == 1

    fake_now += 0.8  # 1.3s >= 1.2s post-turn cooldown
    assert await ticker.tick_once() is True
    assert len(queued) == 2


@pytest.mark.asyncio
async def test_gemini_service_stops_cleanly_on_quota_or_rate_limit_error(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-quota")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0)
    contract = load_action_contract()

    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    class PeerSpy:
        def __init__(self) -> None:
            self.messages: list[dict[str, Any]] = []

        async def send_text(self, data: str) -> None:
            self.messages.append(json.loads(data))

    peer = PeerSpy()
    await relay.register_client(peer)
    push_error_mock = AsyncMock()
    service.push_error = push_error_mock  # type: ignore[method-assign]

    should_retry = await service._handle_connection_error(
        RuntimeError("429 RESOURCE_EXHAUSTED: Quota exceeded for Gemini Live session")
    )

    assert should_retry is False
    assert coordinator.state == "error"
    push_error_mock.assert_awaited_once()
    assert any(
        m.get("type") == "session_status" and m.get("state") == "error" for m in peer.messages
    )


@pytest.mark.asyncio
async def test_session_manager_ingest_captured_jpeg_queues_user_image_raw_frame(
    tmp_path: Path,
) -> None:
    import io

    from PIL import Image, ImageDraw
    from pipecat.frames.frames import UserImageRawFrame

    from openbot_bridge.server import WebRTCSessionManager

    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-ingest")
    relay = ToolRelay(default_timeout_s=1.0)
    contract = load_action_contract()

    manager = WebRTCSessionManager(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
    )

    queued_frames: list[Any] = []

    class FakeTask:
        async def queue_frame(self, frame: Any) -> None:
            queued_frames.append(frame)

    manager._pipeline_tasks["pc-1"] = FakeTask()  # type: ignore[assignment]

    img = Image.new("RGB", (160, 90), (25, 60, 100))
    ImageDraw.Draw(img).rectangle((0, 0, 80, 45), fill=(220, 220, 220))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)

    delivered = await manager.ingest_captured_jpeg(buf.getvalue())
    assert delivered == 1
    assert manager.frames_ingested == 1
    assert len(queued_frames) == 1
    queued = queued_frames[0]
    assert isinstance(queued, UserImageRawFrame)
    assert queued.size == (160, 90)
    assert queued.format == "RGB"


@pytest.mark.asyncio
async def test_tactical_decision_ticker_watchdog_nudges_and_resets_on_stall(
    tmp_path: Path,
) -> None:
    from pipecat.frames.frames import LLMFullResponseEndFrame

    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-watchdog")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0)
    contract = load_action_contract()
    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    fake_now = 10.0
    queued_texts: list[str] = []
    reset_calls = 0

    async def fake_queue(frame: Any) -> None:
        queued_texts.append(getattr(frame, "text", ""))

    async def fake_reset() -> None:
        nonlocal reset_calls
        reset_calls += 1

    ticker = TacticalDecisionTicker(
        frame_sampler=sampler,
        llm_service=service,
        queue_frame_fn=fake_queue,
        interval_s=0.1,
        post_turn_cooldown_s=1.0,
        turn_timeout_s=10.0,
        clock_fn=lambda: fake_now,
        stall_nudge_threshold=2,
        stall_reset_threshold=4,
        on_stall_reset=fake_reset,
    )
    service.register_tool_call_listener(ticker.record_tool_call)
    service._ready_for_realtime_input = True
    service._disconnecting = False
    service._bot_is_responding = False

    async def complete_turn_via_frame() -> None:
        nonlocal fake_now
        await service.push_frame(LLMFullResponseEndFrame())
        fake_now += 1.5

    # Turn 1 emitted -> skipped ticks while in-flight NEVER increment consecutive_empty_ticks
    sampler.last_frame_captured_at_ms = 100.0
    assert await ticker.tick_once() is True
    fake_now += 2.0
    sampler.last_frame_captured_at_ms = 150.0
    assert await ticker.tick_once() is False
    assert ticker.consecutive_empty_ticks == 0

    # Turn 1 completes with zero tool calls -> consecutive_empty_ticks becomes 1
    await complete_turn_via_frame()
    assert ticker.consecutive_empty_ticks == 1

    # Turn 2 emitted and completes with zero tool calls -> consecutive_empty_ticks becomes 2
    sampler.last_frame_captured_at_ms = 200.0
    assert await ticker.tick_once() is True
    assert ticker.watchdog_nudges_sent == 0
    await complete_turn_via_frame()
    assert ticker.consecutive_empty_ticks == 2

    # Turn 3 & 4 trigger watchdog nudges only AFTER 2+ completed empty turns
    sampler.last_frame_captured_at_ms = 300.0
    assert await ticker.tick_once() is True
    assert ticker.watchdog_nudges_sent == 1
    assert "WATCHDOG NOTICE" in queued_texts[-1]
    await complete_turn_via_frame()
    assert ticker.consecutive_empty_ticks == 3

    sampler.last_frame_captured_at_ms = 400.0
    assert await ticker.tick_once() is True
    assert ticker.watchdog_nudges_sent == 2
    await complete_turn_via_frame()
    assert ticker.consecutive_empty_ticks == 4

    # Next tick hits stall_reset_threshold (4 completed empty turns) -> resets session
    sampler.last_frame_captured_at_ms = 500.0
    assert await ticker.tick_once() is True
    assert reset_calls == 1
    assert ticker.watchdog_resets_sent == 1
    assert ticker.consecutive_empty_ticks == 0

    # Observing a real tool call before turn completion keeps consecutive_empty_ticks at 0
    fake_now += 1.5
    sampler.last_frame_captured_at_ms = 600.0
    assert await ticker.tick_once() is True
    service.notify_tool_call("attack_territory")
    await complete_turn_via_frame()
    assert ticker.consecutive_empty_ticks == 0
    assert ticker.tool_calls_observed == 1


@pytest.mark.asyncio
async def test_ticker_safety_timeout_releases_dropped_turn_without_deadlock(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-timeout")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0)
    contract = load_action_contract()
    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )
    service._ready_for_realtime_input = True
    service._disconnecting = False
    service._bot_is_responding = False

    fake_now = 50.0
    queued: list[Any] = []

    async def fake_queue(frame: Any) -> None:
        queued.append(frame)

    ticker = TacticalDecisionTicker(
        frame_sampler=sampler,
        llm_service=service,
        queue_frame_fn=fake_queue,
        interval_s=0.5,
        post_turn_cooldown_s=1.2,
        turn_timeout_s=10.0,
        clock_fn=lambda: fake_now,
    )

    sampler.last_frame_captured_at_ms = 1000.0
    assert await ticker.tick_once() is True
    assert ticker.turn_in_flight is True

    # Before 10s timeout -> still locked
    fake_now += 9.5
    sampler.last_frame_captured_at_ms = 2000.0
    assert await ticker.tick_once() is False
    assert len(queued) == 1

    # Past 10s safety timeout -> releases lock, counts 1 empty turn, and emits next turn
    fake_now += 0.6
    assert await ticker.tick_once() is True
    assert len(queued) == 2
    assert ticker.turn_timeouts == 1
    assert ticker.consecutive_empty_ticks == 1


def test_build_gemini_service_sets_start_audio_paused_without_disabling_server_vad(
    tmp_path: Path,
) -> None:
    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-audio")
    relay = ToolRelay(default_timeout_s=1.0)
    sampler = OneFpsFrameSampler(max_fps=1.0)
    contract = load_action_contract()

    service = build_gemini_service(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        frame_sampler=sampler,
    )

    assert service._audio_input_paused is True
    assert service._vad_disabled is False


@pytest.mark.asyncio
async def test_ws_capture_ingestion_disables_unused_webrtc_video_receiver(
    tmp_path: Path,
) -> None:
    import asyncio
    import io

    from PIL import Image

    from openbot_bridge.server import WebRTCSessionManager

    cfg = _test_config(tmp_path)
    store = SessionStore(cfg.session_store_path)
    coordinator = SessionResumptionCoordinator(store=store, session_id="sess-ws-video")
    relay = ToolRelay(default_timeout_s=1.0)
    contract = load_action_contract()

    manager = WebRTCSessionManager(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
    )
    bundle = build_bridge_pipeline(
        config=cfg,
        contract=contract,
        coordinator=coordinator,
        tool_relay=relay,
        ice_servers=[],
    )

    async def dummy_video_reader() -> None:
        await asyncio.sleep(60)

    input_transport = bundle.transport.input()
    reader_task = asyncio.create_task(dummy_video_reader())
    input_transport._receive_video_task = reader_task  # type: ignore[assignment]

    class FakeTask:
        async def queue_frame(self, _frame: Any) -> None:
            return None

    manager._sessions["pc-ws"] = bundle
    manager._pipeline_tasks["pc-ws"] = FakeTask()  # type: ignore[assignment]

    img = Image.new("RGB", (64, 64), (40, 80, 120))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)

    delivered = await manager.ingest_captured_jpeg(buf.getvalue())
    assert delivered == 1
    assert bundle.transport._params.video_in_enabled is False
    assert input_transport._params.video_in_enabled is False
    assert input_transport._receive_video_task is None
    assert reader_task.cancelled() or reader_task.done()

    await bundle.connection.disconnect()
