"""Tests for BridgeConfig loading and secret redaction."""

from __future__ import annotations

from pathlib import Path

import pytest

from openbot_bridge.config import load_config, redact_secret
from openbot_bridge.errors import BridgeConfigError


def test_config_redacts_gemini_api_key_in_repr_str_and_summary(tmp_path: Path) -> None:
    secret = "AIzaSySuperSecretKeyValue12345"
    cfg = load_config(
        env={
            "GEMINI_API_KEY": secret,
            "OPENBOT_SESSION_STORE_PATH": str(tmp_path / "sess.json"),
        }
    )
    assert cfg.gemini_api_key == secret
    assert secret not in repr(cfg)
    assert secret not in str(cfg)
    assert "***REDACTED***" in repr(cfg)
    assert cfg.safe_summary()["gemini_api_key"] == "***REDACTED***"
    assert cfg.bridge_host == "127.0.0.1"
    assert cfg.bridge_port == 8765
    assert cfg.max_fps == 1.0


def test_config_requires_api_key_when_flagged() -> None:
    with pytest.raises(BridgeConfigError):
        load_config(env={}, require_api_key=True)


def test_config_loads_dual_brain_defaults_and_overrides(tmp_path: Path) -> None:
    defaults = load_config(env={"OPENBOT_SESSION_STORE_PATH": str(tmp_path / "sess.json")})
    assert defaults.brain_mode == "dual"
    assert defaults.lmstudio_base_url == "http://127.0.0.1:1234/v1"
    assert defaults.lmstudio_model == "google/gemma-4-12b"
    assert defaults.system1_provider == "lmstudio"
    assert defaults.system1_timeout_s == 4.0
    assert defaults.system1_interval_s == 0.2
    assert defaults.system1_width == 768
    assert defaults.system1_height == 432
    assert defaults.system1_jpeg_quality == 62
    assert defaults.gemini_strategist_model == "gemini-3.1-flash-lite-preview"
    assert defaults.strategist_interval_s == 25.0

    gemini_defaults = load_config(
        env={
            "OPENBOT_SYSTEM1_PROVIDER": "gemini",
            "OPENBOT_SESSION_STORE_PATH": str(tmp_path / "sess2.json"),
        }
    )
    assert gemini_defaults.system1_timeout_s == 5.5

    custom = load_config(
        env={
            "OPENBOT_BRAIN_MODE": "gemini_live",
            "LMSTUDIO_BASE_URL": "http://127.0.0.1:2345/v1/",
            "LMSTUDIO_MODEL": "google/gemma-4-e4b",
            "OPENBOT_SYSTEM1_PROVIDER": "gemini",
            "OPENBOT_SYSTEM1_TIMEOUT_S": "12.5",
            "OPENBOT_SYSTEM1_WIDTH": "640",
            "OPENBOT_SYSTEM1_HEIGHT": "360",
            "OPENBOT_SYSTEM1_JPEG_QUALITY": "72",
            "GEMINI_STRATEGIST_MODEL": "gemini-3-flash-preview",
            "OPENBOT_STRATEGIST_INTERVAL_S": "20",
        }
    )
    assert custom.brain_mode == "gemini_live"
    assert custom.lmstudio_base_url == "http://127.0.0.1:2345/v1"
    assert custom.lmstudio_model == "google/gemma-4-e4b"
    assert custom.system1_provider == "gemini"
    assert custom.system1_timeout_s == 12.5
    assert custom.system1_width == 640
    assert custom.system1_height == 360
    assert custom.system1_jpeg_quality == 72
    assert custom.gemini_strategist_model == "gemini-3-flash-preview"
    assert custom.strategist_interval_s == 20.0

    with pytest.raises(BridgeConfigError):
        load_config(env={"OPENBOT_BRAIN_MODE": "invalid"})

    with pytest.raises(BridgeConfigError):
        load_config(env={"OPENBOT_SYSTEM1_PROVIDER": "openai"})

    with pytest.raises(BridgeConfigError):
        load_config(env={"OPENBOT_SYSTEM1_JPEG_QUALITY": "5"})


def test_config_validates_port_and_fps() -> None:
    with pytest.raises(BridgeConfigError):
        load_config(env={"OPENBOT_BRIDGE_PORT": "99999"})

    with pytest.raises(BridgeConfigError):
        load_config(env={"OPENBOT_MAX_FPS": "0"})

    assert redact_secret("") == "<unset>"
