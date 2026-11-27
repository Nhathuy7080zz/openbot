"""Configuration loading and secret-safe representation for OpenBot bridge."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values

from openbot_bridge.errors import BridgeConfigError

DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
DEFAULT_GEMINI_STRATEGIST_MODEL = "gemini-3.1-flash-lite-preview"
DEFAULT_BRAIN_MODE: Literal["dual", "gemini_live", "auto"] = "dual"
DEFAULT_SYSTEM1_PROVIDER: Literal["lmstudio", "gemini"] = "lmstudio"
DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1"
DEFAULT_LMSTUDIO_MODEL = "google/gemma-4-12b"
DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = 8765
DEFAULT_MAX_FPS = 1.0
DEFAULT_TOOL_TIMEOUT_S = 10.0
DEFAULT_DECISION_INTERVAL_S = 2.0
DEFAULT_SYSTEM1_CLOUD_TIMEOUT_S = 5.5
DEFAULT_SYSTEM1_LOCAL_TIMEOUT_S = 4.0
DEFAULT_SYSTEM1_TIMEOUT_S = DEFAULT_SYSTEM1_LOCAL_TIMEOUT_S
DEFAULT_SYSTEM1_INTERVAL_S = 0.2
DEFAULT_SYSTEM1_WIDTH = 768
DEFAULT_SYSTEM1_HEIGHT = 432
DEFAULT_SYSTEM1_JPEG_QUALITY = 62
DEFAULT_STRATEGIST_INTERVAL_S = 25.0
DEFAULT_STRATEGIST_TIMEOUT_S = 25.0


def _default_bridge_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_contract_path() -> Path:
    return _default_bridge_root().parent / "contracts" / "action-protocol.json"


def _default_session_store_path() -> Path:
    return _default_bridge_root() / ".openbot-session.json"


def redact_secret(value: str) -> str:
    """Return a redacted placeholder when a secret is present."""
    if not value:
        return "<unset>"
    return "***REDACTED***"


@dataclass(frozen=True)
class BridgeConfig:
    """Validated runtime configuration for the OpenBot Python bridge."""

    gemini_api_key: str
    gemini_live_model: str = DEFAULT_GEMINI_LIVE_MODEL
    bridge_host: str = DEFAULT_BRIDGE_HOST
    bridge_port: int = DEFAULT_BRIDGE_PORT
    session_store_path: Path = field(default_factory=_default_session_store_path)
    contract_path: Path = field(default_factory=_default_contract_path)
    max_fps: float = DEFAULT_MAX_FPS
    tool_timeout_s: float = DEFAULT_TOOL_TIMEOUT_S
    decision_interval_s: float = DEFAULT_DECISION_INTERVAL_S
    debug_frame_path: Path | None = None
    brain_mode: Literal["dual", "gemini_live", "auto"] = DEFAULT_BRAIN_MODE
    lmstudio_base_url: str = DEFAULT_LMSTUDIO_BASE_URL
    lmstudio_model: str = DEFAULT_LMSTUDIO_MODEL
    system1_provider: Literal["lmstudio", "gemini"] = DEFAULT_SYSTEM1_PROVIDER
    system1_timeout_s: float = DEFAULT_SYSTEM1_TIMEOUT_S
    system1_interval_s: float = DEFAULT_SYSTEM1_INTERVAL_S
    system1_width: int = DEFAULT_SYSTEM1_WIDTH
    system1_height: int = DEFAULT_SYSTEM1_HEIGHT
    system1_jpeg_quality: int = DEFAULT_SYSTEM1_JPEG_QUALITY
    gemini_strategist_model: str = DEFAULT_GEMINI_STRATEGIST_MODEL
    strategist_interval_s: float = DEFAULT_STRATEGIST_INTERVAL_S
    strategist_timeout_s: float = DEFAULT_STRATEGIST_TIMEOUT_S

    def __repr__(self) -> str:
        return (
            "BridgeConfig("
            f"gemini_api_key={redact_secret(self.gemini_api_key)!r}, "
            f"brain_mode={self.brain_mode!r}, "
            f"lmstudio_base_url={self.lmstudio_base_url!r}, "
            f"lmstudio_model={self.lmstudio_model!r}, "
            f"system1_provider={self.system1_provider!r}, "
            f"gemini_strategist_model={self.gemini_strategist_model!r}, "
            f"gemini_live_model={self.gemini_live_model!r}, "
            f"bridge_host={self.bridge_host!r}, "
            f"bridge_port={self.bridge_port!r}, "
            f"session_store_path={str(self.session_store_path)!r}, "
            f"contract_path={str(self.contract_path)!r}, "
            f"max_fps={self.max_fps!r}, "
            f"tool_timeout_s={self.tool_timeout_s!r}, "
            f"decision_interval_s={self.decision_interval_s!r}, "
            f"debug_frame_path={str(self.debug_frame_path) if self.debug_frame_path else None!r}"
            ")"
        )

    def __str__(self) -> str:
        return self.__repr__()

    def safe_summary(self) -> dict[str, object]:
        """Return a log-safe dictionary representation with secrets redacted."""
        return {
            "gemini_api_key": redact_secret(self.gemini_api_key),
            "brain_mode": self.brain_mode,
            "lmstudio_base_url": self.lmstudio_base_url,
            "lmstudio_model": self.lmstudio_model,
            "system1_provider": self.system1_provider,
            "system1_timeout_s": self.system1_timeout_s,
            "system1_interval_s": self.system1_interval_s,
            "system1_resolution": f"{self.system1_width}x{self.system1_height}",
            "gemini_strategist_model": self.gemini_strategist_model,
            "strategist_interval_s": self.strategist_interval_s,
            "gemini_live_model": self.gemini_live_model,
            "bridge_host": self.bridge_host,
            "bridge_port": self.bridge_port,
            "session_store_path": str(self.session_store_path),
            "contract_path": str(self.contract_path),
            "max_fps": self.max_fps,
            "tool_timeout_s": self.tool_timeout_s,
            "decision_interval_s": self.decision_interval_s,
            "debug_frame_path": str(self.debug_frame_path) if self.debug_frame_path else None,
        }


def _parse_int(raw: str, name: str, *, min_value: int, max_value: int) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise BridgeConfigError(f"Invalid integer for {name}: {raw!r}") from exc
    if value < min_value or value > max_value:
        raise BridgeConfigError(
            f"{name} must be between {min_value} and {max_value}, got {value}"
        )
    return value


def _parse_positive_float(raw: str, name: str) -> float:
    try:
        value = float(raw)
    except ValueError as exc:
        raise BridgeConfigError(f"Invalid float for {name}: {raw!r}") from exc
    if value <= 0.0:
        raise BridgeConfigError(f"{name} must be > 0, got {value}")
    return value


def _parse_brain_mode(raw: str) -> Literal["dual", "gemini_live", "auto"]:
    cleaned = raw.strip().lower()
    if cleaned == "dual":
        return "dual"
    if cleaned == "gemini_live":
        return "gemini_live"
    if cleaned == "auto":
        return "auto"
    raise BridgeConfigError(
        f"OPENBOT_BRAIN_MODE must be one of 'dual', 'gemini_live', 'auto', got {raw!r}"
    )


def _parse_system1_provider(raw: str) -> Literal["lmstudio", "gemini"]:
    cleaned = raw.strip().lower()
    if cleaned == "lmstudio":
        return "lmstudio"
    if cleaned == "gemini":
        return "gemini"
    raise BridgeConfigError(
        f"OPENBOT_SYSTEM1_PROVIDER must be 'lmstudio' or 'gemini', got {raw!r}"
    )


def load_config(
    env: Mapping[str, str] | None = None,
    *,
    dotenv_path: Path | None = None,
    require_api_key: bool = False,
) -> BridgeConfig:
    """Load and validate BridgeConfig from environment and optional .env file."""
    merged: dict[str, str] = {}
    if env is None:
        candidate_dotenv = dotenv_path or (_default_bridge_root().parent / ".env")
        if candidate_dotenv.is_file():
            for key, val in dotenv_values(candidate_dotenv).items():
                if val is not None:
                    merged[key] = val
        merged.update(os.environ)
    else:
        if dotenv_path is not None and dotenv_path.is_file():
            for key, val in dotenv_values(dotenv_path).items():
                if val is not None:
                    merged[key] = val
        merged.update(env)

    api_key = merged.get("GEMINI_API_KEY", "").strip()
    if require_api_key and not api_key:
        raise BridgeConfigError("GEMINI_API_KEY is required when starting a live Gemini session")

    model = merged.get("GEMINI_LIVE_MODEL", DEFAULT_GEMINI_LIVE_MODEL).strip()
    if not model:
        raise BridgeConfigError("GEMINI_LIVE_MODEL must not be empty")

    brain_mode = _parse_brain_mode(merged.get("OPENBOT_BRAIN_MODE", DEFAULT_BRAIN_MODE))
    lmstudio_base_url = (
        merged.get("LMSTUDIO_BASE_URL", DEFAULT_LMSTUDIO_BASE_URL).strip().rstrip("/")
        or DEFAULT_LMSTUDIO_BASE_URL
    )
    lmstudio_model = merged.get("LMSTUDIO_MODEL", DEFAULT_LMSTUDIO_MODEL).strip()
    if not lmstudio_model:
        raise BridgeConfigError("LMSTUDIO_MODEL must not be empty")

    system1_provider = _parse_system1_provider(
        merged.get("OPENBOT_SYSTEM1_PROVIDER", DEFAULT_SYSTEM1_PROVIDER)
    )
    gemini_strategist_model = merged.get(
        "GEMINI_STRATEGIST_MODEL", DEFAULT_GEMINI_STRATEGIST_MODEL
    ).strip()
    if not gemini_strategist_model:
        raise BridgeConfigError("GEMINI_STRATEGIST_MODEL must not be empty")

    host = merged.get("OPENBOT_BRIDGE_HOST", DEFAULT_BRIDGE_HOST).strip() or DEFAULT_BRIDGE_HOST
    port = _parse_int(
        merged.get("OPENBOT_BRIDGE_PORT", str(DEFAULT_BRIDGE_PORT)),
        "OPENBOT_BRIDGE_PORT",
        min_value=1,
        max_value=65535,
    )
    max_fps = _parse_positive_float(
        merged.get("OPENBOT_MAX_FPS", str(DEFAULT_MAX_FPS)),
        "OPENBOT_MAX_FPS",
    )
    tool_timeout_s = _parse_positive_float(
        merged.get("OPENBOT_TOOL_TIMEOUT_S", str(DEFAULT_TOOL_TIMEOUT_S)),
        "OPENBOT_TOOL_TIMEOUT_S",
    )
    decision_interval_s = _parse_positive_float(
        merged.get("OPENBOT_DECISION_INTERVAL_S", str(DEFAULT_DECISION_INTERVAL_S)),
        "OPENBOT_DECISION_INTERVAL_S",
    )
    raw_s1_timeout = merged.get("OPENBOT_SYSTEM1_TIMEOUT_S", "").strip()
    if raw_s1_timeout:
        system1_timeout_s = _parse_positive_float(raw_s1_timeout, "OPENBOT_SYSTEM1_TIMEOUT_S")
    elif system1_provider == "gemini":
        system1_timeout_s = DEFAULT_SYSTEM1_CLOUD_TIMEOUT_S
    else:
        system1_timeout_s = DEFAULT_SYSTEM1_LOCAL_TIMEOUT_S
    system1_interval_s = _parse_positive_float(
        merged.get("OPENBOT_SYSTEM1_INTERVAL_S", str(DEFAULT_SYSTEM1_INTERVAL_S)),
        "OPENBOT_SYSTEM1_INTERVAL_S",
    )
    system1_width = _parse_int(
        merged.get("OPENBOT_SYSTEM1_WIDTH", str(DEFAULT_SYSTEM1_WIDTH)),
        "OPENBOT_SYSTEM1_WIDTH",
        min_value=320,
        max_value=1920,
    )
    system1_height = _parse_int(
        merged.get("OPENBOT_SYSTEM1_HEIGHT", str(DEFAULT_SYSTEM1_HEIGHT)),
        "OPENBOT_SYSTEM1_HEIGHT",
        min_value=180,
        max_value=1080,
    )
    system1_jpeg_quality = _parse_int(
        merged.get("OPENBOT_SYSTEM1_JPEG_QUALITY", str(DEFAULT_SYSTEM1_JPEG_QUALITY)),
        "OPENBOT_SYSTEM1_JPEG_QUALITY",
        min_value=30,
        max_value=95,
    )
    strategist_interval_s = _parse_positive_float(
        merged.get("OPENBOT_STRATEGIST_INTERVAL_S", str(DEFAULT_STRATEGIST_INTERVAL_S)),
        "OPENBOT_STRATEGIST_INTERVAL_S",
    )
    strategist_timeout_s = _parse_positive_float(
        merged.get("OPENBOT_STRATEGIST_TIMEOUT_S", str(DEFAULT_STRATEGIST_TIMEOUT_S)),
        "OPENBOT_STRATEGIST_TIMEOUT_S",
    )

    raw_session_path = merged.get("OPENBOT_SESSION_STORE_PATH", "").strip()
    session_store_path = (
        Path(raw_session_path) if raw_session_path else _default_session_store_path()
    )

    raw_contract_path = merged.get("OPENBOT_CONTRACT_PATH", "").strip()
    contract_path = Path(raw_contract_path) if raw_contract_path else _default_contract_path()

    raw_debug_frame = merged.get("OPENBOT_DEBUG_FRAME_PATH", "").strip()
    debug_frame_path = Path(raw_debug_frame) if raw_debug_frame else None

    return BridgeConfig(
        gemini_api_key=api_key,
        gemini_live_model=model,
        bridge_host=host,
        bridge_port=port,
        session_store_path=session_store_path,
        contract_path=contract_path,
        max_fps=max_fps,
        tool_timeout_s=tool_timeout_s,
        decision_interval_s=decision_interval_s,
        debug_frame_path=debug_frame_path,
        brain_mode=brain_mode,
        lmstudio_base_url=lmstudio_base_url,
        lmstudio_model=lmstudio_model,
        system1_provider=system1_provider,
        system1_timeout_s=system1_timeout_s,
        system1_interval_s=system1_interval_s,
        system1_width=system1_width,
        system1_height=system1_height,
        system1_jpeg_quality=system1_jpeg_quality,
        gemini_strategist_model=gemini_strategist_model,
        strategist_interval_s=strategist_interval_s,
        strategist_timeout_s=strategist_timeout_s,
    )
