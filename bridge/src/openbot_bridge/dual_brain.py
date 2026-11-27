"""Dual-Brain Coordinator fusing System 1 (LM Studio Gemma 4) and System 2 (Gemini Strategist)."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from contextlib import suppress
from typing import Any

from loguru import logger

from openbot_bridge.config import BridgeConfig
from openbot_bridge.contract import ActionRequest, HudSnapshot
from openbot_bridge.frame_grid import PreparedFrame, prepare_tactical_frame
from openbot_bridge.system1_tactical import System1TacticalClient
from openbot_bridge.system2_strategist import System2Strategist
from openbot_bridge.tool_relay import ToolRelay


def format_hud_header(hud: HudSnapshot | None, *, camera_zoomed: bool = False) -> str:
    """Format latest HudSnapshot into a compact header for tactical and strategic prompts."""
    if hud is None:
        base = "[HUD: unavailable (waiting for DOM poll)]"
    elif hud.game_over:
        base = (
            f"[HUD: GAME_OVER timer={hud.match_timer or '?'} "
            f"gold={hud.gold_text or '?'} detail={hud.game_over_text or 'ended'}]"
        )
    else:
        timer = hud.match_timer or "?"
        gold = hud.gold_text or (str(int(hud.gold)) if hud.gold is not None else "?")
        troops = str(int(hud.troops)) if hud.troops is not None else "?"
        max_troops = str(int(hud.max_troops)) if hud.max_troops is not None else "?"
        troop_str = f"{troops}/{max_troops}" + (
            f" ({hud.troop_rate})" if hud.panel_visible and hud.troop_rate else ""
        )
        ratio = f"{hud.attack_ratio_pct}%" if hud.attack_ratio_pct is not None else "?"
        panel = "active" if hud.panel_visible else "spawn_or_hidden"
        base = f"[HUD: timer={timer} gold={gold} troops={troop_str} ratio={ratio} panel={panel}]"

    if camera_zoomed:
        return f"{base} | [CAMERA: zoomed_in — call reset_overview]"
    return base


class DualBrainCoordinator:
    """Runs non-blocking System 2 strategist alongside stateless System 1 tactical loop."""

    def __init__(
        self,
        *,
        config: BridgeConfig,
        tool_relay: ToolRelay,
        system1: System1TacticalClient | None = None,
        system2: System2Strategist | None = None,
    ) -> None:
        self._config = config
        self._relay = tool_relay
        self.system1 = system1 or System1TacticalClient(
            base_url=config.lmstudio_base_url,
            model=config.lmstudio_model,
            provider=config.system1_provider,
            gemini_api_key=config.gemini_api_key,
            gemini_model=config.gemini_strategist_model,
            timeout_s=config.system1_timeout_s,
        )
        self.system2 = system2 or System2Strategist(
            api_key=config.gemini_api_key,
            model=config.gemini_strategist_model,
            timeout_s=config.strategist_timeout_s,
        )

        self._latest_frame: PreparedFrame | None = None
        self._latest_frame_at_ms: float = 0.0
        self._last_consumed_frame_ms: float = 0.0
        self._latest_hud: HudSnapshot | None = None
        self._outcomes: deque[str] = deque(maxlen=8)

        self.frames_ingested = 0
        self.frames_rejected = 0
        self.hud_received_count = 0
        self.plans_dispatched = 0
        self.sub_actions_dispatched = 0
        self.camera_zoomed = False
        self.zoomed_turns = 0
        self.debug_saved = False
        self._spawn_coord: tuple[float, float] | None = None
        self._last_failed_build_coord: tuple[float, float] | None = None
        self._build_retry_index = 0

        self._running = False
        self._tactical_task: asyncio.Task[None] | None = None
        self._strategist_task: asyncio.Task[None] | None = None

    @property
    def recent_outcomes(self) -> list[str]:
        return list(self._outcomes)

    def on_hud_snapshot(self, hud: HudSnapshot) -> None:
        self._latest_hud = hud
        self.hud_received_count += 1

    def ingest_frame(self, jpeg_bytes: bytes) -> bool:
        """Prepare incoming raw JPEG frame with coordinate grid overlay for both System 1 and 2."""
        debug_path = (
            self._config.debug_frame_path
            if self._config.debug_frame_path is not None and not self.debug_saved
            else None
        )
        prepared = prepare_tactical_frame(
            jpeg_bytes,
            width=self._config.system1_width,
            height=self._config.system1_height,
            quality=self._config.system1_jpeg_quality,
            debug_frame_path=debug_path,
        )
        if prepared is None:
            self.frames_rejected += 1
            return False

        if debug_path is not None and debug_path.is_file():
            self.debug_saved = True

        self._latest_frame = prepared
        self._latest_frame_at_ms = time.time() * 1000.0
        self.frames_ingested += 1
        return True

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._tactical_task = asyncio.create_task(self._tactical_loop())
        self._strategist_task = asyncio.create_task(self._strategist_loop())

    async def stop(self) -> None:
        self._running = False
        for task in (self._tactical_task, self._strategist_task):
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self._tactical_task = None
        self._strategist_task = None
        await self.system1.close()
        await self.system2.close()

    async def _tactical_loop(self) -> None:
        while self._running:
            try:
                acted = await self.run_one_tactical_turn()
                if acted:
                    sleep_s = self._config.system1_interval_s
                elif self.system1.last_error and "429" in self.system1.last_error:
                    sleep_s = 1.0
                else:
                    sleep_s = 0.15
                await asyncio.sleep(sleep_s)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(f"DualBrain tactical loop error: {exc}")
                await asyncio.sleep(0.5)

    async def _strategist_loop(self) -> None:
        while self._running:
            try:
                frame = self._latest_frame
                if frame is not None and self._relay.has_client:
                    hud = self._latest_hud
                    if hud is None or not hud.game_over:
                        await self.system2.refresh_once(
                            jpeg_bytes=frame.jpeg_bytes,
                            hud_line=format_hud_header(hud, camera_zoomed=self.camera_zoomed),
                            recent_outcomes=list(self._outcomes),
                        )
                await asyncio.sleep(self._config.strategist_interval_s)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(f"DualBrain strategist loop error: {exc}")
                await asyncio.sleep(self._config.strategist_interval_s)

    async def run_one_tactical_turn(self) -> bool:
        """Execute a single System 1 turn if fresh frame + /ws/actions client are ready."""
        frame = self._latest_frame
        if frame is None or not self._relay.has_client:
            return False
        if self._latest_frame_at_ms <= self._last_consumed_frame_ms:
            return False
        if self._latest_hud is not None and self._latest_hud.game_over:
            return False

        frame_ts = self._latest_frame_at_ms
        hud_line = format_hud_header(self._latest_hud, camera_zoomed=self.camera_zoomed)
        directive_block = self.system2.current_directive.to_prompt_block()
        decision = await self.system1.decide(
            jpeg_bytes=frame.jpeg_bytes,
            hud_line=hud_line,
            directive_block=directive_block,
            recent_outcomes=list(self._outcomes),
        )
        if decision is None:
            # Drop stale timed-out/failed turn immediately without locking next frame timestamp.
            return False

        self._last_consumed_frame_ms = frame_ts
        actions = self._enforce_camera_hygiene(self._guard_active_actions(decision.actions))
        call_id = f"db-{uuid.uuid4().hex[:10]}"
        req = ActionRequest(
            call_id=call_id,
            session_id="dual-brain",
            tool_name="execute_plan",
            arguments={
                "actions": actions,
                "step_delay_ms": 80,
                "rationale": decision.rationale[:96],
            },
            frame_captured_at_ms=frame_ts,
            model_emitted_at_ms=time.time() * 1000.0,
        )
        response = await self._relay.dispatch_action(
            req,
            timeout_s=max(self._config.tool_timeout_s, 12.0),
        )
        self.plans_dispatched += 1
        self.sub_actions_dispatched += len(actions)
        self._record_outcome(
            actions,
            response.status,
            response.summary,
            response.artifacts,
        )
        return True

    def _enforce_camera_hygiene(self, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Redirect repeated failed build coords, reset stale zoom, and inject periodic focus."""
        adjusted: list[dict[str, Any]] = []
        offsets = [(0.0, 0.0), (0.03, 0.0), (-0.03, 0.0), (0.0, 0.03), (0.0, -0.03)]
        for step in actions:
            if (
                step.get("tool_name") == "build_structure"
                and self._last_failed_build_coord is not None
                and self._spawn_coord is not None
            ):
                args = dict(step.get("arguments") or {})
                bx = float(args.get("x", 0.5))
                by = float(args.get("y", 0.5))
                fx, fy = self._last_failed_build_coord
                if abs(bx - fx) <= 0.03 and abs(by - fy) <= 0.03:
                    dx, dy = offsets[self._build_retry_index % len(offsets)]
                    self._build_retry_index += 1
                    sx, sy = self._spawn_coord
                    args["x"] = round(min(0.95, max(0.05, sx + dx)), 3)
                    args["y"] = round(min(0.95, max(0.05, sy + dy)), 3)
                    step = {**step, "arguments": args}
            adjusted.append(step)

        if self.camera_zoomed and self.zoomed_turns >= 2:
            if any(step.get("tool_name") == "reset_overview" for step in adjusted):
                return adjusted
            reset_step: dict[str, Any] = {
                "tool_name": "reset_overview",
                "arguments": {"zoom_out_steps": 6, "rationale": "Reset macro overview"},
            }
            return [*adjusted[:4], reset_step]

        hud = self._latest_hud
        if (
            not self.camera_zoomed
            and hud is not None
            and hud.panel_visible
            and self.plans_dispatched >= 4
            and self.plans_dispatched % 8 == 4
            and not any(
                step.get("tool_name") in ("focus_region", "reset_overview", "build_structure")
                for step in adjusted
            )
        ):
            anchor = next(
                (
                    step.get("arguments") or {}
                    for step in adjusted
                    if step.get("tool_name") in ("expand_burst", "attack_territory")
                ),
                None,
            )
            if anchor is not None and "x" in anchor and "y" in anchor:
                fx, fy = float(anchor["x"]), float(anchor["y"])
            elif self._spawn_coord is not None:
                fx, fy = self._spawn_coord
            else:
                fx, fy = 0.5, 0.5
            focus_step: dict[str, Any] = {
                "tool_name": "focus_region",
                "arguments": {
                    "x": fx,
                    "y": fy,
                    "zoom_steps": 2,
                    "rationale": "Inspect sector camera",
                },
            }
            return [*adjusted[:4], focus_step]

        return adjusted

    def _guard_active_actions(self, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Track spawn coordinate and convert stale select_spawn steps once HUD is active."""
        panel_visible = self._latest_hud is not None and self._latest_hud.panel_visible
        guarded: list[dict[str, Any]] = []
        for step in actions:
            if step.get("tool_name") == "select_spawn":
                args = dict(step.get("arguments") or {})
                if not panel_visible:
                    self._spawn_coord = (float(args.get("x", 0.5)), float(args.get("y", 0.5)))
                    guarded.append(step)
                else:
                    guarded.append(
                        {
                            "tool_name": "attack_territory",
                            "arguments": {
                                "x": args.get("x", 0.5),
                                "y": args.get("y", 0.5),
                                "rationale": args.get("rationale", "expand border"),
                            },
                        }
                    )
            else:
                guarded.append(step)
        return guarded

    def _record_outcome(
        self,
        actions: list[dict[str, Any]],
        status: str,
        summary: str,
        artifacts: dict[str, Any],
    ) -> None:
        step_results = artifacts.get("stepResults")
        executed_tools: list[str] = []
        if isinstance(step_results, list) and step_results:
            for item in step_results:
                if isinstance(item, dict):
                    tool_name = str(item.get("toolName", "step"))
                    st = str(item.get("status", status))
                    step_sum = str(item.get("summary", summary))
                    self._outcomes.append(f"{tool_name}:{st} ({step_sum[:70]})")
                    executed_tools.append(tool_name)
                    if tool_name == "build_structure":
                        if st == "success":
                            self._last_failed_build_coord = None
                        elif st == "failed":
                            raw_idx = item.get("index")
                            idx = raw_idx if isinstance(raw_idx, int) else -1
                            src_step = (
                                actions[idx]
                                if 0 <= idx < len(actions)
                                and actions[idx].get("tool_name") == "build_structure"
                                else next(
                                    (s for s in actions if s.get("tool_name") == "build_structure"),
                                    None,
                                )
                            )
                            if src_step is not None:
                                s_args = src_step.get("arguments") or {}
                                self._last_failed_build_coord = (
                                    float(s_args.get("x", 0.5)),
                                    float(s_args.get("y", 0.5)),
                                )
        else:
            names = "+".join(str(a.get("tool_name", "?")) for a in actions[:3])
            self._outcomes.append(f"{names}:{status} ({summary[:70]})")
            executed_tools.extend(str(a.get("tool_name", "")) for a in actions)

        for tool in executed_tools:
            if tool == "focus_region":
                self.camera_zoomed = True
            elif tool == "reset_overview":
                self.camera_zoomed = False
                self.zoomed_turns = 0

        if self.camera_zoomed:
            self.zoomed_turns += 1
        else:
            self.zoomed_turns = 0

    def stats(self) -> dict[str, Any]:
        s1 = self.system1.stats()
        s2 = self.system2.stats()
        return {
            "brain_mode": "dual",
            "system1_provider": s1["provider"],
            "system1_model": s1["model"],
            "system1_calls_total": s1["calls_total"],
            "system1_calls_succeeded": s1["calls_succeeded"],
            "system1_calls_failed": s1["calls_failed"],
            "system1_p50_ms": s1["p50_ms"],
            "system1_p95_ms": s1["p95_ms"],
            "system1_last_ms": s1["last_ms"],
            "reasoning_tokens_total": s1["reasoning_tokens_total"],
            "system2_model": s2["model"],
            "system2_enabled": s2["enabled"],
            "system2_refreshes_succeeded": s2["refreshes_succeeded"],
            "system2_refreshes_failed": s2["refreshes_failed"],
            "system2_p50_ms": s2["p50_ms"],
            "system2_p95_ms": s2["p95_ms"],
            "system2_phase": s2["current_phase"],
            "frames_ingested": self.frames_ingested,
            "frames_rejected": self.frames_rejected,
            "hud_received_count": self.hud_received_count,
            "plans_dispatched": self.plans_dispatched,
            "sub_actions_dispatched": self.sub_actions_dispatched,
        }
