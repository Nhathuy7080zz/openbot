"""TDD tests for contract loading, Pydantic IPC schemas, and Gemini tool declarations."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from openbot_bridge.contract import (
    ActionRequest,
    ActionResponse,
    HudSnapshot,
    PingPong,
    RecoveryPayload,
    SessionStatus,
    build_gemini_tool_declarations,
    default_contract_path,
    load_action_contract,
)
from openbot_bridge.errors import ContractError


def test_default_contract_loads_all_non_blocking_tools() -> None:
    contract = load_action_contract(default_contract_path())
    assert contract.version == "2.1.0"
    assert contract.ipc.host == "127.0.0.1"
    assert contract.ipc.default_port == 8765
    assert contract.ipc.ws_action_path == "/ws/actions"
    assert contract.ipc.http_health_path == "/health"
    assert contract.ipc.http_webrtc_offer_path == "/webrtc/offer"

    names = [decl.name for decl in contract.gemini_function_declarations]
    assert names == [
        "select_spawn",
        "attack_territory",
        "set_attack_ratio",
        "build_structure",
        "launch_special",
        "diplomacy_action",
        "camera_control",
        "zoom_map",
        "pan_map",
        "wait_observe",
        "focus_region",
        "reset_overview",
        "execute_plan",
        "expand_burst",
    ]
    assert all(decl.behavior == "NON_BLOCKING" for decl in contract.gemini_function_declarations)


def test_gemini_tool_declarations_preserve_non_blocking_and_unit_bounds() -> None:
    contract = load_action_contract(default_contract_path())
    declarations = build_gemini_tool_declarations(contract)

    assert len(declarations) == 14
    by_name = {d["name"]: d for d in declarations}
    assert set(by_name["build_structure"]["parameters"]["properties"]["structure"]["enum"]) == {
        "city",
        "factory",
        "port",
        "defense_post",
        "missile_silo",
        "sam_launcher",
        "warship",
        "atom_bomb",
        "hydrogen_bomb",
        "mirv",
    }

    for name in (
        "select_spawn",
        "attack_territory",
        "build_structure",
        "launch_special",
        "diplomacy_action",
    ):
        decl = by_name[name]
        assert decl["behavior"] == "NON_BLOCKING"
        props = decl["parameters"]["properties"]
        assert props["x"]["minimum"] == 0.0
        assert props["x"]["maximum"] == 1.0
        assert props["y"]["minimum"] == 0.0
        assert props["y"]["maximum"] == 1.0
        assert "rationale" in decl["parameters"]["required"]

    assert by_name["camera_control"]["behavior"] == "NON_BLOCKING"
    assert by_name["wait_observe"]["behavior"] == "NON_BLOCKING"


def test_load_action_contract_raises_contract_error_on_missing_or_invalid_file(
    tmp_path: Path,
) -> None:
    with pytest.raises(ContractError):
        load_action_contract(tmp_path / "missing.json")

    bad_file = tmp_path / "bad.json"
    bad_file.write_text("{not-json", encoding="utf-8")
    with pytest.raises(ContractError):
        load_action_contract(bad_file)

    incomplete = tmp_path / "incomplete.json"
    incomplete.write_text(json.dumps({"version": "1.0.0"}), encoding="utf-8")
    with pytest.raises(ContractError):
        load_action_contract(incomplete)


def test_ipc_pydantic_models_validate_and_reject_invalid_payloads() -> None:
    req = ActionRequest(
        call_id="call-1",
        session_id="sess-1",
        tool_name="select_spawn",
        arguments={"x": 0.5, "y": 0.5, "rationale": "center"},
        frame_captured_at_ms=1000.0,
        model_emitted_at_ms=1025.0,
    )
    assert req.type == "action_request"

    with pytest.raises(ValidationError):
        ActionRequest(
            call_id="",
            session_id="sess-1",
            tool_name="select_spawn",
            arguments={},
            frame_captured_at_ms=-1.0,
            model_emitted_at_ms=10.0,
        )

    resp = ActionResponse(
        call_id="call-1",
        status="error",
        summary="Timed out waiting for actuator",
        next_actions=["wait_observe"],
        artifacts={},
        latency_ms=5000.0,
        scheduling="WHEN_IDLE",
        recovery=RecoveryPayload(
            root_cause="timeout",
            safe_retry="retry once",
            stop_condition="abort after 3 failures",
        ),
    )
    assert resp.type == "action_response"
    assert resp.recovery is not None

    status = SessionStatus(
        session_id="sess-1",
        state="go_away",
        resumption_handle_present=True,
        timestamp_ms=12345.0,
    )
    assert status.type == "session_status"

    failed_resp = ActionResponse(
        call_id="call-2",
        status="failed",
        summary="Build failed: insufficient_gold_or_invalid_tile",
        next_actions=["attack_territory"],
        artifacts={"verified": False},
        latency_ms=420.0,
        scheduling="WHEN_IDLE",
    )
    assert failed_resp.status == "failed"

    hud = HudSnapshot(
        timestamp_ms=5000.0,
        panel_visible=True,
        game_over=False,
        gold=250_000.0,
        gold_text="250K",
        troops=42_000.0,
        max_troops=80_000.0,
        troop_rate="+1.5K/s",
        attack_ratio_pct=30,
        match_timer="01:42",
        game_over_text=None,
    )
    assert hud.type == "hud_snapshot"

    ping = PingPong(type="ping", timestamp_ms=99.0)
    assert ping.type == "ping"
