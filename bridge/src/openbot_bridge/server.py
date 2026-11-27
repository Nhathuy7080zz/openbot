"""FastAPI localhost server exposing /health, /webrtc/offer, /capture-client, and WebSockets."""

from __future__ import annotations

import asyncio
import io
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from loguru import logger
from PIL import Image
from pipecat.frames.frames import LLMRunFrame, UserImageRawFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pydantic import BaseModel, ConfigDict, Field

from openbot_bridge.config import BridgeConfig, load_config
from openbot_bridge.contract import ActionProtocolContract, load_action_contract
from openbot_bridge.dual_brain import DualBrainCoordinator
from openbot_bridge.errors import BridgeConfigError, ToolRelayError
from openbot_bridge.gemini_live import (
    BridgePipelineBundle,
    TacticalDecisionTicker,
    build_bridge_pipeline,
)
from openbot_bridge.session_store import SessionResumptionCoordinator, SessionStore
from openbot_bridge.tool_relay import ToolRelay

WebRTCOfferHandler = Callable[[str, str, str | None], Awaitable[dict[str, Any]]]

CAPTURE_CLIENT_HTML = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>OpenBot WebRTC Capture Bridge</title></head>
<body style="margin:0;background:#111;color:#eee;font-family:monospace">
<div id="status">connecting</div>
<canvas id="capture-canvas" width="1280" height="720"></canvas>
<script>
(async () => {
  const statusEl = document.getElementById('status');
  const canvas = document.getElementById('capture-canvas');
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(2);
  const videoTrack = stream.getVideoTracks()[0];
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.createDataChannel('openbot-ctrl');
  for (const track of stream.getVideoTracks()) {
    pc.addTrack(track, stream);
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, 1500);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const resp = await fetch('/webrtc/offer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type })
  });
  if (!resp.ok) {
    statusEl.textContent = 'offer_failed_' + resp.status;
    return;
  }
  const answer = await resp.json();
  await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  statusEl.textContent = 'webrtc_connected';

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '/ws/capture-frames?role=publisher');
  ws.binaryType = 'arraybuffer';
  ws.onmessage = async (ev) => {
    try {
      const blob = new Blob([ev.data], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      if (videoTrack && typeof videoTrack.requestFrame === 'function') {
        videoTrack.requestFrame();
      }
      bitmap.close();
      statusEl.textContent = 'streaming';
    } catch (err) {
      statusEl.textContent = 'decode_err';
    }
  };
})();
</script>
</body>
</html>
"""


class WebRTCOfferRequest(BaseModel):
    """Browser WebRTC SDP offer payload."""

    model_config = ConfigDict(extra="ignore")

    sdp: str = Field(min_length=1)
    type: str = Field(min_length=1)
    pc_id: str | None = None


class CaptureFrameHub:
    """Relays composited JPEG frames from TS ViewportCapture to /capture-client WebRTC tab."""

    def __init__(self) -> None:
        self._publishers: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.frames_relayed = 0

    async def register_publisher(self, ws: WebSocket) -> None:
        async with self._lock:
            self._publishers.add(ws)

    async def unregister_publisher(self, ws: WebSocket) -> None:
        async with self._lock:
            self._publishers.discard(ws)

    async def relay_frame(self, data: bytes) -> int:
        async with self._lock:
            targets = list(self._publishers)
        delivered = 0
        for ws in targets:
            try:
                await ws.send_bytes(data)
                delivered += 1
            except Exception:
                await self.unregister_publisher(ws)
        if delivered > 0:
            self.frames_relayed += 1
        return delivered


class WebRTCSessionManager:
    """Manages active SmallWebRTCConnections and their Pipecat PipelineTasks."""

    def __init__(
        self,
        *,
        config: BridgeConfig,
        contract: ActionProtocolContract,
        coordinator: SessionResumptionCoordinator,
        tool_relay: ToolRelay,
    ) -> None:
        self._config = config
        self._contract = contract
        self._coordinator = coordinator
        self._tool_relay = tool_relay
        self._sessions: dict[str, BridgePipelineBundle] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._pipeline_tasks: dict[str, PipelineTask] = {}
        self._tickers: dict[str, TacticalDecisionTicker] = {}
        self._ws_capture_active = False
        self.frames_ingested = 0

    def latest_frame_stats(self) -> dict[str, Any] | None:
        if not self._sessions:
            return None
        latest_bundle = list(self._sessions.values())[-1]
        return latest_bundle.frame_sampler.stats()

    def latest_ticker_stats(self) -> dict[str, Any] | None:
        if not self._tickers or not self._sessions:
            return None
        latest_conn = list(self._tickers.keys())[-1]
        ticker = self._tickers[latest_conn]
        bundle = self._sessions.get(latest_conn)
        return {
            "ticks_sent": ticker.ticks_sent,
            "turns_completed": ticker.turns_completed,
            "turn_timeouts": ticker.turn_timeouts,
            "turn_in_flight": ticker.turn_in_flight,
            "consecutive_empty_ticks": ticker.consecutive_empty_ticks,
            "tool_calls_observed": ticker.tool_calls_observed,
            "watchdog_nudges_sent": ticker.watchdog_nudges_sent,
            "watchdog_resets_sent": ticker.watchdog_resets_sent,
            "gemini_ready": bundle.llm_service.is_ready_for_turn if bundle else False,
        }

    async def handle_offer(
        self,
        sdp: str,
        offer_type: str,
        pc_id: str | None = None,
    ) -> dict[str, Any]:
        """Accept a WebRTC SDP offer, initialize or renegotiate connection, and start pipeline."""
        if not self._config.gemini_api_key:
            raise BridgeConfigError(
                "GEMINI_API_KEY is required before accepting a live WebRTC session"
            )

        if pc_id and pc_id in self._sessions:
            bundle = self._sessions[pc_id]
            await bundle.connection.renegotiate(sdp=sdp, type=offer_type)
            if self._ws_capture_active:
                await bundle.disable_webrtc_video_in()
            answer = bundle.connection.get_answer()  # type: ignore[no-untyped-call]
            if answer is None:
                raise HTTPException(status_code=500, detail="Failed to build WebRTC SDP answer")
            return dict(answer)

        bundle = build_bridge_pipeline(
            config=self._config,
            contract=self._contract,
            coordinator=self._coordinator,
            tool_relay=self._tool_relay,
        )
        if self._ws_capture_active:
            await bundle.disable_webrtc_video_in()
        await bundle.connection.initialize(sdp=sdp, type=offer_type)
        answer = bundle.connection.get_answer()  # type: ignore[no-untyped-call]
        if answer is None:
            raise HTTPException(status_code=500, detail="Failed to build WebRTC SDP answer")

        conn_id = str(answer["pc_id"])
        self._sessions[conn_id] = bundle

        task = PipelineTask(
            bundle.pipeline,
            params=PipelineParams(enable_metrics=True),
            cancel_on_idle_timeout=False,
        )
        self._pipeline_tasks[conn_id] = task
        ticker = TacticalDecisionTicker(
            frame_sampler=bundle.frame_sampler,
            llm_service=bundle.llm_service,
            queue_frame_fn=task.queue_frame,
            interval_s=self._config.decision_interval_s,
            on_stall_reset=bundle.llm_service.reset_stalled_session,
        )
        bundle.llm_service.register_tool_call_listener(ticker.record_tool_call)
        self._tickers[conn_id] = ticker
        ticker.start()

        runner = PipelineRunner(handle_sigint=False)

        async def _run_pipeline() -> None:
            try:
                await runner.run(task)
            finally:
                await ticker.stop()
                self._tickers.pop(conn_id, None)
                self._pipeline_tasks.pop(conn_id, None)
                self._sessions.pop(conn_id, None)
                self._tasks.pop(conn_id, None)

        self._tasks[conn_id] = asyncio.create_task(_run_pipeline())
        await task.queue_frame(LLMRunFrame())
        return dict(answer)

    async def ingest_captured_jpeg(self, jpeg_bytes: bytes) -> int:
        """Decode composited JPEG viewport bytes and queue UserImageRawFrame to active tasks."""
        if not self._pipeline_tasks:
            return 0
        try:
            with Image.open(io.BytesIO(jpeg_bytes)) as img:
                rgb = img.convert("RGB")
                size = rgb.size
                rgb_bytes = rgb.tobytes()
        except (OSError, ValueError) as exc:
            logger.warning(f"Ignoring invalid captured JPEG frame: {exc}")
            return 0

        self._ws_capture_active = True
        for bundle in list(self._sessions.values()):
            if bundle.transport._params.video_in_enabled:
                await bundle.disable_webrtc_video_in()

        delivered = 0
        for conn_id, task in list(self._pipeline_tasks.items()):
            try:
                frame = UserImageRawFrame(image=rgb_bytes, size=size, format="RGB")
                await task.queue_frame(frame)
                delivered += 1
            except Exception as exc:
                logger.warning(f"Failed queuing captured frame for session {conn_id}: {exc}")
        if delivered > 0:
            self.frames_ingested += 1
        return delivered

    async def close_all(self) -> None:
        """Disconnect all active WebRTC peer connections and cancel background tasks."""
        for ticker in list(self._tickers.values()):
            await ticker.stop()
        self._tickers.clear()
        self._pipeline_tasks.clear()
        for conn_id, task in list(self._tasks.items()):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            self._tasks.pop(conn_id, None)
        for conn_id, bundle in list(self._sessions.items()):
            await bundle.connection.disconnect()  # type: ignore[no-untyped-call]
            self._sessions.pop(conn_id, None)


def create_app(
    *,
    config: BridgeConfig | None = None,
    contract: ActionProtocolContract | None = None,
    tool_relay: ToolRelay | None = None,
    coordinator: SessionResumptionCoordinator | None = None,
    webrtc_offer_handler: WebRTCOfferHandler | None = None,
) -> FastAPI:
    """Create the FastAPI bridge application bound to contract IPC endpoints."""
    cfg = config or load_config()
    loaded_contract = contract or load_action_contract(cfg.contract_path)
    relay = tool_relay or ToolRelay(default_timeout_s=cfg.tool_timeout_s)
    store = SessionStore(cfg.session_store_path)
    coord = coordinator or SessionResumptionCoordinator(
        store=store,
        session_id=f"openbot-{uuid.uuid4().hex[:12]}",
    )
    frame_hub = CaptureFrameHub()
    active_brain_mode = "dual" if cfg.brain_mode in ("dual", "auto") else "gemini_live"
    dual_brain: DualBrainCoordinator | None = None
    if active_brain_mode == "dual":
        dual_brain = DualBrainCoordinator(config=cfg, tool_relay=relay)
        relay.register_hud_listener(dual_brain.on_hud_snapshot)

    manager = WebRTCSessionManager(
        config=cfg,
        contract=loaded_contract,
        coordinator=coord,
        tool_relay=relay,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> Any:
        if dual_brain is not None:
            await dual_brain.start()
        try:
            yield
        finally:
            if dual_brain is not None:
                await dual_brain.stop()
            await manager.close_all()

    app = FastAPI(
        title="OpenBot Dual-Brain & Pipecat Bridge",
        version=loaded_contract.version,
        lifespan=lifespan,
    )
    app.state.config = cfg
    app.state.contract = loaded_contract
    app.state.tool_relay = relay
    app.state.coordinator = coord
    app.state.frame_hub = frame_hub
    app.state.dual_brain = dual_brain

    @app.get(loaded_contract.ipc.http_health_path)
    async def health() -> dict[str, Any]:
        frames_ingested = (
            dual_brain.frames_ingested if dual_brain is not None else manager.frames_ingested
        )
        return {
            "status": "ok",
            "host": cfg.bridge_host,
            "port": cfg.bridge_port,
            "contract_version": loaded_contract.version,
            "brain_mode": active_brain_mode,
            "session_id": coord.session_id,
            "session_state": coord.state,
            "resumption_handle_present": coord.current_handle is not None,
            "resumption_count": coord.resumption_count,
            "ws_clients": relay.client_count,
            "frames_relayed": frame_hub.frames_relayed,
            "frames_ingested": frames_ingested,
            "frame_health": manager.latest_frame_stats(),
            "decision_ticker": manager.latest_ticker_stats(),
            "dual_brain": dual_brain.stats() if dual_brain is not None else None,
        }

    @app.get("/capture-client", response_class=HTMLResponse)
    async def capture_client() -> HTMLResponse:
        return HTMLResponse(CAPTURE_CLIENT_HTML)

    @app.post(loaded_contract.ipc.http_webrtc_offer_path)
    async def webrtc_offer(offer: WebRTCOfferRequest) -> dict[str, Any]:
        if webrtc_offer_handler is not None:
            return await webrtc_offer_handler(offer.sdp, offer.type, offer.pc_id)
        try:
            return await manager.handle_offer(offer.sdp, offer.type, offer.pc_id)
        except BridgeConfigError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.websocket("/ws/capture-frames")
    async def ws_capture_frames(websocket: WebSocket) -> None:
        role = websocket.query_params.get("role", "source")
        await websocket.accept()
        if role == "publisher":
            await frame_hub.register_publisher(websocket)
            try:
                while True:
                    await websocket.receive_text()
            except WebSocketDisconnect:
                pass
            finally:
                await frame_hub.unregister_publisher(websocket)
            return

        try:
            while True:
                frame_bytes = await websocket.receive_bytes()
                if dual_brain is not None:
                    dual_brain.ingest_frame(frame_bytes)
                else:
                    ingested = await manager.ingest_captured_jpeg(frame_bytes)
                    if ingested == 0:
                        await frame_hub.relay_frame(frame_bytes)
        except WebSocketDisconnect:
            pass

    @app.websocket(loaded_contract.ipc.ws_action_path)
    async def ws_actions(websocket: WebSocket) -> None:
        await websocket.accept()
        await relay.register_client(websocket)
        try:
            await relay.broadcast_session_status(coord.to_session_status())
            while True:
                raw_text = await websocket.receive_text()
                try:
                    await relay.handle_incoming_message(raw_text)
                except ToolRelayError as exc:
                    logger.warning(f"Rejected invalid /ws/actions message: {exc}")
        except WebSocketDisconnect:
            pass
        finally:
            await relay.unregister_client(websocket)

    return app


def main() -> None:
    """Run the OpenBot localhost bridge server."""
    cfg = load_config()
    logger.info(f"Starting OpenBot bridge with config: {cfg.safe_summary()}")
    app = create_app(config=cfg)
    uvicorn.run(app, host=cfg.bridge_host, port=cfg.bridge_port, log_level="info")


if __name__ == "__main__":
    main()
