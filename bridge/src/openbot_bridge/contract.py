"""Contract loader and Pydantic IPC models mirroring contracts/action-protocol.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openbot_bridge.errors import ContractError


def default_contract_path() -> Path:
    """Return the canonical path to contracts/action-protocol.json."""
    return Path(__file__).resolve().parents[3] / "contracts" / "action-protocol.json"


class CoordinateSpaceContract(BaseModel):
    model_config = ConfigDict(extra="allow")

    min: float
    max: float
    origin: str
    description: str


class IpcContract(BaseModel):
    model_config = ConfigDict(extra="allow")

    host: str = Field(min_length=1)
    default_port: int = Field(ge=1, le=65535)
    ws_action_path: str = Field(min_length=1)
    http_health_path: str = Field(min_length=1)
    http_webrtc_offer_path: str = Field(min_length=1)
    message_schemas: dict[str, Any] = Field(default_factory=dict)


class GeminiFunctionDeclarationContract(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    behavior: Literal["NON_BLOCKING", "BLOCKING"] = "NON_BLOCKING"
    parameters: dict[str, Any]


class ActionProtocolContract(BaseModel):
    model_config = ConfigDict(extra="allow")

    version: str = Field(min_length=1)
    coordinate_space: CoordinateSpaceContract
    ipc: IpcContract
    gemini_function_declarations: list[GeminiFunctionDeclarationContract] = Field(min_length=1)


class ActionRequest(BaseModel):
    """Action invocation forwarded from Gemini NON_BLOCKING tool call to TS orchestrator."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["action_request"] = "action_request"
    call_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    arguments: dict[str, Any]
    frame_captured_at_ms: float = Field(ge=0.0)
    model_emitted_at_ms: float = Field(ge=0.0)


class RecoveryPayload(BaseModel):
    """Structured error recovery instructions returned to Gemini when an action fails."""

    model_config = ConfigDict(extra="forbid")

    root_cause: str = Field(min_length=1)
    safe_retry: str = Field(min_length=1)
    stop_condition: str = Field(min_length=1)


class ActionResponse(BaseModel):
    """Deterministic observation payload returned from TS orchestrator to Gemini."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["action_response"] = "action_response"
    call_id: str = Field(min_length=1)
    status: Literal["success", "warning", "failed", "error"]
    summary: str = Field(min_length=1)
    next_actions: list[str]
    artifacts: dict[str, Any]
    latency_ms: float = Field(ge=0.0)
    scheduling: Literal["SILENT", "WHEN_IDLE", "INTERRUPT"]
    recovery: RecoveryPayload | None = None


class HudSnapshot(BaseModel):
    """Public rendered HUD state pushed periodically over /ws/actions."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["hud_snapshot"] = "hud_snapshot"
    timestamp_ms: float = Field(ge=0.0)
    panel_visible: bool
    game_over: bool
    gold: float | None = Field(default=None, ge=0.0)
    gold_text: str | None = None
    troops: float | None = Field(default=None, ge=0.0)
    max_troops: float | None = Field(default=None, ge=0.0)
    troop_rate: str | None = None
    attack_ratio_pct: int | None = Field(default=None, ge=0, le=100)
    match_timer: str | None = None
    game_over_text: str | None = None


class SessionStatus(BaseModel):
    """Bridge session lifecycle event pushed over /ws/actions."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["session_status"] = "session_status"
    session_id: str = Field(min_length=1)
    state: Literal["connected", "go_away", "resumed", "reconnecting", "closed", "error"]
    resumption_handle_present: bool
    timestamp_ms: float = Field(ge=0.0)


class PingPong(BaseModel):
    """Heartbeat message exchanged over /ws/actions."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["ping", "pong"]
    timestamp_ms: float = Field(ge=0.0)


def load_action_contract(path: Path | None = None) -> ActionProtocolContract:
    """Load and validate contracts/action-protocol.json."""
    target = path or default_contract_path()
    if not target.is_file():
        raise ContractError(f"Action protocol contract not found at {target}")
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"Failed to read action contract at {target}: {exc}") from exc

    try:
        contract = ActionProtocolContract.model_validate(raw)
    except ValidationError as exc:
        raise ContractError(f"Action contract validation failed: {exc}") from exc

    non_blocking = [
        d for d in contract.gemini_function_declarations if d.behavior == "NON_BLOCKING"
    ]
    if len(non_blocking) != len(contract.gemini_function_declarations):
        raise ContractError("All contract gemini_function_declarations must specify NON_BLOCKING")

    return contract


def build_gemini_tool_declarations(contract: ActionProtocolContract) -> list[dict[str, Any]]:
    """Convert contract declarations into Gemini function_declarations dicts preserving bounds."""
    declarations: list[dict[str, Any]] = []
    for decl in contract.gemini_function_declarations:
        declarations.append(
            {
                "name": decl.name,
                "description": decl.description,
                "behavior": decl.behavior,
                "parameters": json.loads(json.dumps(decl.parameters)),
            }
        )
    return declarations
