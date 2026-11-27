"""Typed error hierarchy for OpenBot Python bridge."""

from __future__ import annotations

from typing import Any


class BridgeError(Exception):
    """Base exception for all OpenBot bridge failures."""

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}


class BridgeConfigError(BridgeError):
    """Raised when bridge configuration or environment variables are invalid."""


class ContractError(BridgeError):
    """Raised when action-protocol.json cannot be loaded or fails validation."""


class SessionResumptionError(BridgeError):
    """Raised when Gemini Live session resumption state cannot be persisted or recovered."""


class ToolRelayError(BridgeError):
    """Raised when action relay over /ws/actions encounters a protocol or transport error."""
