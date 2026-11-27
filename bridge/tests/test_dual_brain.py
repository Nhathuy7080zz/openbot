"""Mocked TDD unit tests for Phase 6 Dual-Brain engine (grid, System 1, System 2, coordinator)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from openbot_bridge.config import BridgeConfig, load_config
from openbot_bridge.contract import ActionResponse, HudSnapshot, load_action_contract
from openbot_bridge.dual_brain import DualBrainCoordinator, format_hud_header
from openbot_bridge.frame_grid import prepare_tactical_frame
from openbot_bridge.server import create_app
from openbot_bridge.system1_tactical import System1TacticalClient
from openbot_bridge.system2_strategist import CommanderDirective, System2Strategist
from openbot_bridge.tool_relay import ToolRelay


def _make_jpeg(
    width: int = 1280,
    height: int = 720,
    color: tuple[int, int, int] = (40, 90, 140),
) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def test_frame_grid_resizes_draws_overlay_rejects_blank_and_saves_debug(tmp_path: Path) -> None:
    blank = _make_jpeg(640, 360, (0, 0, 0))
    assert prepare_tactical_frame(blank) is None

    debug_path = tmp_path / "artifacts" / "debug-frame.png"
    raw = _make_jpeg(1280, 720, (35, 110, 65))
    prepared = prepare_tactical_frame(
        raw,
        width=960,
        height=540,
        quality=68,
        debug_frame_path=debug_path,
    )
    assert prepared is not None
    assert prepared.width == 960
    assert prepared.height == 540
    assert debug_path.is_file()

    # Subsequent calls should not crash and output valid 960x540 JPEG bytes
    prepared_second = prepare_tactical_frame(raw, width=960, height=540, quality=68)
    assert prepared_second is not None
    with Image.open(io.BytesIO(prepared_second.jpeg_bytes)) as img:
        assert img.size == (960, 540)


async def test_system1_lmstudio_enforces_reasoning_none_stateless_payload_and_normalizes() -> None:
    captured_payloads: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "http://127.0.0.1:1234/v1/chat/completions"
        payload = json.loads(request.content.decode("utf-8"))
        captured_payloads.append(payload)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "rationale": "expand north and port",
                                    "actions": [
                                        {
                                            "tool_name": "set_attack_ratio",
                                            "ratio_pct": 35,
                                        },
                                        {
                                            "tool_name": "attack_territory",
                                            "x": 1.25,
                                            "y": 0.42,
                                            "mode": "ground",
                                        },
                                        {
                                            "tool_name": "focus_region",
                                            "x": 0.22,
                                            "y": 0.78,
                                            "zoom_steps": 3,
                                        },
                                        {
                                            "tool_name": "build_structure",
                                            "structure": "warship",
                                            "x": 0.24,
                                            "y": 0.80,
                                        },
                                    ],
                                }
                            ),
                        }
                    }
                ],
                "usage": {
                    "prompt_tokens": 500,
                    "completion_tokens": 90,
                    "completion_tokens_details": {"reasoning_tokens": 0},
                },
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = System1TacticalClient(
            base_url="http://127.0.0.1:1234/v1",
            model="google/gemma-4-12b",
            provider="lmstudio",
            http_client=http_client,
        )
        decision = await client.decide(
            jpeg_bytes=_make_jpeg(320, 180),
            hud_line=(
                "[HUD: timer=00:45 gold=150K troops=12000/40000 (+400/s) "
                "ratio=20% panel=active]"
            ),
            directive_block=(
                "[DIRECTIVE phase=early] priority=north_coast\n"
                "build=port,city camera=overview note=push north"
            ),
            recent_outcomes=[
                "build_structure(city): failed insufficient_gold_or_invalid_tile"
            ],
        )

    assert len(captured_payloads) == 1
    req = captured_payloads[0]
    assert req["model"] == "google/gemma-4-12b"
    assert req["reasoning_effort"] == "none"
    assert req["response_format"]["type"] == "json_schema"
    assert len(req["messages"]) == 2
    assert req["messages"][0]["role"] == "system"
    assert req["messages"][1]["role"] == "user"
    user_text = req["messages"][1]["content"][0]["text"]
    assert "[HUD:" in user_text
    assert "[DIRECTIVE" in user_text
    assert "insufficient_gold_or_invalid_tile" in user_text

    assert decision is not None
    assert decision.rationale == "expand north and port"
    assert len(decision.actions) == 4
    assert decision.actions[0] == {
        "tool_name": "set_attack_ratio",
        "arguments": {"ratio_pct": 35, "rationale": "expand north and port"},
    }
    # Clamped coordinate x=1.25 -> 1.0
    assert decision.actions[1]["tool_name"] == "attack_territory"
    assert decision.actions[1]["arguments"]["x"] == 1.0
    assert decision.actions[1]["arguments"]["mode"] == "ground"
    assert decision.actions[2] == {
        "tool_name": "focus_region",
        "arguments": {"x": 0.22, "y": 0.78, "zoom_steps": 3, "rationale": "expand north and port"},
    }
    assert decision.actions[3] == {
        "tool_name": "build_structure",
        "arguments": {
            "structure": "warship",
            "x": 0.24,
            "y": 0.8,
            "rationale": "expand north and port",
        },
    }
    stats = client.stats()
    assert stats["calls_succeeded"] == 1
    assert stats["reasoning_tokens_total"] == 0


async def test_system2_strategist_merges_directive_and_degrades_gracefully() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.headers.get("x-goog-api-key") == "test-gemini-key"
        assert "test-gemini-key" not in str(request.url)
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["generationConfig"]["responseMimeType"] == "application/json"
        assert payload["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "minimal"
        if calls == 1:
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {
                                        "text": json.dumps(
                                            {
                                                "phase": "mid",
                                                "priority_sectors": ["0.7,0.3", "0.3,0.6"],
                                                "target_enemies": ["Red"],
                                                "ally_targets": ["Blue"],
                                                "build_queue": ["port", "city", "sam_launcher"],
                                                "camera_goal": "focus_east_border",
                                                "notes": "Fortify border and scale income",
                                            }
                                        )
                                    }
                                ]
                            }
                        }
                    ]
                },
            )
        return httpx.Response(429, json={"error": {"message": "Rate limited"}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        strategist = System2Strategist(
            api_key="test-gemini-key",
            model="gemini-3.1-flash-lite-preview",
            http_client=http_client,
        )
        ok_dir = await strategist.refresh_once(
            jpeg_bytes=_make_jpeg(320, 180),
            hud_line="[HUD: timer=03:00 gold=300K troops=50K/120K ratio=30% panel=active]",
            recent_outcomes=["execute_plan: success"],
        )
        assert isinstance(ok_dir, CommanderDirective)
        assert ok_dir.phase == "mid"
        block = ok_dir.to_prompt_block()
        assert len(block.splitlines()) == 2
        assert "focus_east_border" in block

        # Second call fails with HTTP 429 -> retains last valid directive gracefully
        fallback_dir = await strategist.refresh_once(
            jpeg_bytes=_make_jpeg(320, 180),
            hud_line="[HUD: timer=03:20 gold=320K troops=55K/120K ratio=30% panel=active]",
            recent_outcomes=[],
        )
        assert fallback_dir.phase == "mid"
        assert fallback_dir.target_enemies == ["Red"]
        stats = strategist.stats()
        assert stats["refreshes_succeeded"] == 1
        assert stats["refreshes_failed"] == 1


async def test_dual_brain_coordinator_runs_tactical_plan_and_records_failed_build() -> None:
    relay = ToolRelay(default_timeout_s=2.0)
    sent_requests: list[dict[str, Any]] = []

    class FakeWsPeer:
        async def send_text(self, data: str) -> None:
            parsed = json.loads(data)
            if parsed.get("type") == "action_request":
                sent_requests.append(parsed)
                resp = ActionResponse(
                    call_id=parsed["call_id"],
                    status="failed",
                    summary="Build City failed: insufficient_gold_or_invalid_tile",
                    next_actions=["attack_territory"],
                    artifacts={"verified": False, "reason": "insufficient_gold_or_invalid_tile"},
                    latency_ms=415.0,
                    scheduling="WHEN_IDLE",
                )
                await relay.handle_incoming_message(resp.model_dump_json())

    await relay.register_client(FakeWsPeer())

    # Feed HUD snapshot via /ws/actions handler
    hud = HudSnapshot(
        timestamp_ms=1000.0,
        panel_visible=True,
        game_over=False,
        gold=5000.0,
        gold_text="5K",
        troops=2000.0,
        max_troops=10000.0,
        troop_rate="+100/s",
        attack_ratio_pct=25,
        match_timer="00:25",
    )
    assert "gold=5K" in format_hud_header(hud)

    def lm_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "rationale": "expand and city",
                                    "actions": [
                                        {"tool_name": "attack_territory", "x": 0.45, "y": 0.45},
                                        {
                                            "tool_name": "build_structure",
                                            "structure": "city",
                                            "x": 0.5,
                                            "y": 0.5,
                                        },
                                    ],
                                }
                            ),
                        }
                    }
                ],
                "usage": {"completion_tokens_details": {"reasoning_tokens": 0}},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(lm_handler)) as lm_http:
        cfg = BridgeConfig(
            gemini_api_key="",
            brain_mode="dual",
            system1_interval_s=0.05,
            strategist_interval_s=60.0,
        )
        s1 = System1TacticalClient(
            base_url=cfg.lmstudio_base_url,
            model=cfg.lmstudio_model,
            http_client=lm_http,
        )
        s2 = System2Strategist(api_key="", model=cfg.gemini_strategist_model)
        coordinator = DualBrainCoordinator(
            config=cfg,
            tool_relay=relay,
            system1=s1,
            system2=s2,
        )
        relay.register_hud_listener(coordinator.on_hud_snapshot)
        await relay.handle_incoming_message(hud.model_dump_json())

        assert coordinator.ingest_frame(_make_jpeg(1280, 720, (50, 120, 80))) is True
        step_ok = await coordinator.run_one_tactical_turn()
        assert step_ok is True

    assert len(sent_requests) == 1
    req = sent_requests[0]
    assert req["tool_name"] == "execute_plan"
    assert len(req["arguments"]["actions"]) == 2
    assert coordinator.stats()["plans_dispatched"] == 1
    assert coordinator.stats()["sub_actions_dispatched"] == 2
    assert any("insufficient_gold_or_invalid_tile" in o for o in coordinator.recent_outcomes)


def test_server_exposes_dual_brain_mode_and_ingests_hud_and_frames(tmp_path: Path) -> None:
    cfg = load_config(
        env={
            "OPENBOT_BRAIN_MODE": "dual",
            "OPENBOT_SESSION_STORE_PATH": str(tmp_path / "sess.json"),
        }
    )
    contract = load_action_contract()
    app = create_app(config=cfg, contract=contract)

    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        body = health.json()
        assert body["brain_mode"] == "dual"
        assert "dual_brain" in body
        assert body["dual_brain"]["system1_model"] == "google/gemma-4-12b"

        with client.websocket_connect("/ws/actions") as ws_act:
            status_msg = json.loads(ws_act.receive_text())
            assert status_msg["type"] == "session_status"
            ws_act.send_text(
                json.dumps(
                    {
                        "type": "hud_snapshot",
                        "timestamp_ms": 1234,
                        "panel_visible": True,
                        "game_over": False,
                        "gold": 90000,
                        "gold_text": "90K",
                        "troops": 15000,
                        "max_troops": 50000,
                        "troop_rate": "+500/s",
                        "attack_ratio_pct": 30,
                        "match_timer": "00:50",
                        "game_over_text": None,
                    }
                )
            )
            with client.websocket_connect("/ws/capture-frames") as ws_cap:
                ws_cap.send_bytes(_make_jpeg(640, 360, (60, 110, 90)))
                # Allow asyncio loop a brief tick to ingest websocket messages
                ws_act.send_text(json.dumps({"type": "ping", "timestamp_ms": 99}))
                pong = json.loads(ws_act.receive_text())
                assert pong["type"] == "pong"

        health_after = client.get("/health").json()
        assert health_after["frames_ingested"] >= 1
        assert health_after["dual_brain"]["hud_received_count"] >= 1


async def test_compact_wire_schema_and_active_spawn_guard() -> None:
    def lm_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "r": "push coast and build",
                                    "a": [
                                        {"t": "select_spawn", "x": 0.62, "y": 0.34},
                                        {"t": "set_attack_ratio", "x": 0, "y": 0, "v": "35"},
                                        {
                                            "t": "build_structure",
                                            "x": 0.25,
                                            "y": 0.75,
                                            "v": "warship",
                                        },
                                        {"t": "focus_region", "x": 0.25, "y": 0.75, "v": "3"},
                                    ],
                                }
                            ),
                        }
                    }
                ],
                "usage": {"completion_tokens_details": {"reasoning_tokens": 0}},
            },
        )

    relay = ToolRelay(default_timeout_s=2.0)
    sent: list[dict[str, Any]] = []

    class FakeWs:
        async def send_text(self, data: str) -> None:
            parsed = json.loads(data)
            if parsed.get("type") == "action_request":
                sent.append(parsed)
                resp = ActionResponse(
                    call_id=parsed["call_id"],
                    status="success",
                    summary="Executed 4 steps",
                    next_actions=["attack_territory"],
                    artifacts={"executedSteps": 4},
                    latency_ms=100.0,
                    scheduling="SILENT",
                )
                await relay.handle_incoming_message(resp.model_dump_json())

    await relay.register_client(FakeWs())
    async with httpx.AsyncClient(transport=httpx.MockTransport(lm_handler)) as http_client:
        cfg = BridgeConfig(gemini_api_key="", brain_mode="dual")
        s1 = System1TacticalClient(http_client=http_client)
        s2 = System2Strategist(api_key="", model="gemini-3.1-flash-lite-preview")
        coord = DualBrainCoordinator(config=cfg, tool_relay=relay, system1=s1, system2=s2)
        coord.on_hud_snapshot(
            HudSnapshot(timestamp_ms=1000.0, panel_visible=True, game_over=False, gold=200_000.0)
        )
        coord.ingest_frame(_make_jpeg(640, 360, (50, 120, 80)))
        assert await coord.run_one_tactical_turn() is True

    assert len(sent) == 1
    actions = sent[0]["arguments"]["actions"]
    # select_spawn was rewritten to attack_territory while panel_visible=True
    assert actions[0]["tool_name"] == "attack_territory"
    assert actions[0]["arguments"]["x"] == 0.62
    assert actions[1] == {
        "tool_name": "set_attack_ratio",
        "arguments": {"ratio_pct": 35, "rationale": "push coast and build"},
    }
    assert actions[2] == {
        "tool_name": "build_structure",
        "arguments": {
            "structure": "warship",
            "x": 0.25,
            "y": 0.75,
            "rationale": "push coast and build",
        },
    }
    assert actions[3] == {
        "tool_name": "focus_region",
        "arguments": {
            "x": 0.25,
            "y": 0.75,
            "zoom_steps": 3,
            "rationale": "push coast and build",
        },
    }


async def test_system1_gemini_provider_uses_response_schema_and_minimal_thinking() -> None:
    seen_payloads: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-goog-api-key") == "test-s1-key"
        assert "test-s1-key" not in str(request.url)
        body = json.loads(request.content.decode("utf-8"))
        seen_payloads.append(body)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "r": "attack and reset view",
                                            "a": [
                                                {"t": "attack_territory", "x": 0.42, "y": 0.35},
                                                {
                                                    "t": "reset_overview",
                                                    "x": 0.5,
                                                    "y": 0.5,
                                                    "v": "8",
                                                },
                                            ],
                                        }
                                    )
                                }
                            ]
                        }
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = System1TacticalClient(
            provider="gemini",
            gemini_api_key="test-s1-key",
            gemini_model="gemini-3.1-flash-lite-preview",
            http_client=http_client,
        )
        decision = await client.decide(
            jpeg_bytes=_make_jpeg(320, 180),
            hud_line="[HUD: timer=01:00 gold=140K troops=30K/70K ratio=35% panel=active]",
            directive_block=(
                "[DIRECTIVE phase=early] priority=0.4,0.3\n[BUILD_CAMERA] build=city"
            ),
            recent_outcomes=[],
        )

    assert len(seen_payloads) == 1
    gen_cfg = seen_payloads[0]["generationConfig"]
    assert gen_cfg["responseMimeType"] == "application/json"
    assert gen_cfg["responseSchema"]["required"] == ["r", "a"]
    assert gen_cfg["thinkingConfig"]["thinkingLevel"] == "minimal"
    assert decision is not None
    assert decision.actions[0]["tool_name"] == "attack_territory"
    assert decision.actions[1] == {
        "tool_name": "reset_overview",
        "arguments": {"zoom_out_steps": 8, "rationale": "attack and reset view"},
    }


async def test_phase7_expand_burst_camera_hygiene_and_no_timeout_lock() -> None:
    turn_count = 0

    def lm_handler(_request: httpx.Request) -> httpx.Response:
        nonlocal turn_count
        turn_count += 1
        if turn_count == 1:
            raise httpx.ReadTimeout("simulated timeout")
        if turn_count == 2:
            payload = {
                "r": "focus and burst",
                "a": [
                    {"t": "focus_region", "x": 0.4, "y": 0.4, "v": "3"},
                    {"t": "expand_burst", "x": 0.4, "y": 0.4, "v": "0.07"},
                ],
            }
        else:
            payload = {
                "r": "keep pushing",
                "a": [
                    {"t": "attack_territory", "x": 0.45, "y": 0.45},
                ],
            }
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": json.dumps(payload)}}],
                "usage": {"completion_tokens_details": {"reasoning_tokens": 0}},
            },
        )

    relay = ToolRelay(default_timeout_s=2.0)
    sent: list[dict[str, Any]] = []

    class FakeWs:
        async def send_text(self, data: str) -> None:
            parsed = json.loads(data)
            if parsed.get("type") == "action_request":
                sent.append(parsed)
                actions = parsed["arguments"]["actions"]
                step_results = [
                    {
                        "index": i,
                        "toolName": step["tool_name"],
                        "status": "success",
                        "summary": f"{step['tool_name']}:success",
                    }
                    for i, step in enumerate(actions)
                ]
                resp = ActionResponse(
                    call_id=parsed["call_id"],
                    status="success",
                    summary="Executed",
                    next_actions=["attack_territory"],
                    artifacts={"executedSteps": len(actions), "stepResults": step_results},
                    latency_ms=80.0,
                    scheduling="SILENT",
                )
                await relay.handle_incoming_message(resp.model_dump_json())

    await relay.register_client(FakeWs())
    async with httpx.AsyncClient(transport=httpx.MockTransport(lm_handler)) as http_client:
        cfg = BridgeConfig(gemini_api_key="", brain_mode="dual", system1_timeout_s=4.0)
        s1 = System1TacticalClient(http_client=http_client, timeout_s=4.0)
        s2 = System2Strategist(api_key="", model="gemini-3.1-flash-lite-preview")
        coord = DualBrainCoordinator(config=cfg, tool_relay=relay, system1=s1, system2=s2)
        coord.on_hud_snapshot(
            HudSnapshot(timestamp_ms=1000.0, panel_visible=True, game_over=False, gold=150_000.0)
        )
        coord.ingest_frame(_make_jpeg(640, 360, (50, 120, 80)))

        # Turn 1 times out -> returns False without locking _last_consumed_frame_ms
        assert await coord.run_one_tactical_turn() is False
        assert coord._last_consumed_frame_ms == 0.0

        # Turn 2 runs immediately on same frame, normalizes expand_burst, and sets camera_zoomed
        assert await coord.run_one_tactical_turn() is True
        assert coord.camera_zoomed is True
        assert coord.zoomed_turns == 1
        assert "[CAMERA: zoomed_in" in format_hud_header(
            coord._latest_hud, camera_zoomed=coord.camera_zoomed
        )
        assert sent[0]["arguments"]["step_delay_ms"] == 80
        assert sent[0]["arguments"]["actions"][1] == {
            "tool_name": "expand_burst",
            "arguments": {
                "x": 0.4,
                "y": 0.4,
                "spread": 0.07,
                "count": 4,
                "rationale": "focus and burst",
            },
        }

        # Simulated Turn 3 + Turn 4 (after zoomed_turns reaches 2) auto-appends reset_overview
        coord.zoomed_turns = 2
        coord.ingest_frame(_make_jpeg(640, 360, (52, 122, 82)))
        assert await coord.run_one_tactical_turn() is True
        assert [a["tool_name"] for a in sent[1]["arguments"]["actions"]] == [
            "attack_territory",
            "reset_overview",
        ]
        assert coord.camera_zoomed is False
        assert coord.zoomed_turns == 0


async def test_dual_brain_redirects_failed_build_and_injects_periodic_focus() -> None:
    relay = ToolRelay(default_timeout_s=2.0)
    cfg = BridgeConfig(gemini_api_key="", brain_mode="dual", system1_timeout_s=4.0)
    s1 = System1TacticalClient(timeout_s=4.0)
    s2 = System2Strategist(api_key="", model="gemini-3.1-flash-lite-preview")
    coord = DualBrainCoordinator(config=cfg, tool_relay=relay, system1=s1, system2=s2)

    # Spawn capture sets _spawn_coord when panel is not yet visible
    spawn_actions = [{"tool_name": "select_spawn", "arguments": {"x": 0.52, "y": 0.48}}]
    coord._guard_active_actions(spawn_actions)
    assert coord._spawn_coord == (0.52, 0.48)

    # Failed build records failing coordinate and redirects next near-identical build near spawn
    coord.on_hud_snapshot(
        HudSnapshot(timestamp_ms=1000.0, panel_visible=True, game_over=False, gold=90_000.0)
    )
    failed_plan = [
        {"tool_name": "expand_burst", "arguments": {"x": 0.45, "y": 0.45, "rationale": "Burst"}},
        {
            "tool_name": "build_structure",
            "arguments": {"structure": "defense_post", "x": 0.45, "y": 0.45, "rationale": "Fort"},
        },
    ]
    coord._record_outcome(
        failed_plan,
        "warning",
        "Build failed",
        {
            "stepResults": [
                {"index": 0, "toolName": "expand_burst", "status": "success", "summary": "ok"},
                {
                    "index": 1,
                    "toolName": "build_structure",
                    "status": "failed",
                    "summary": "insufficient_gold_or_invalid_tile",
                },
            ]
        },
    )
    assert coord._last_failed_build_coord == (0.45, 0.45)

    redirected = coord._enforce_camera_hygiene(failed_plan)
    assert [a["tool_name"] for a in redirected] == ["expand_burst", "build_structure"]
    assert redirected[1]["arguments"]["x"] == 0.52
    assert redirected[1]["arguments"]["y"] == 0.48

    # Periodic end-of-batch focus_region at plans_dispatched == 4, followed by auto reset at 2 turns
    coord.plans_dispatched = 4
    attack_plan = [
        {"tool_name": "expand_burst", "arguments": {"x": 0.46, "y": 0.44, "rationale": "Push"}},
        {"tool_name": "attack_territory", "arguments": {"x": 0.5, "y": 0.4, "rationale": "Hit"}},
    ]
    focused = coord._enforce_camera_hygiene(attack_plan)
    assert [a["tool_name"] for a in focused] == [
        "expand_burst",
        "attack_territory",
        "focus_region",
    ]
    assert focused[-1]["arguments"]["x"] == 0.46
    assert focused[-1]["arguments"]["y"] == 0.44

    coord.camera_zoomed = True
    coord.zoomed_turns = 2
    reset_plan = coord._enforce_camera_hygiene(attack_plan)
    assert [a["tool_name"] for a in reset_plan] == [
        "expand_burst",
        "attack_territory",
        "reset_overview",
    ]
