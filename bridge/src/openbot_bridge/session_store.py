"""Atomic Gemini Live session resumption store and backoff coordinator."""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openbot_bridge.contract import SessionStatus
from openbot_bridge.errors import SessionResumptionError

SessionState = Literal["connected", "go_away", "resumed", "reconnecting", "closed", "error"]


class SessionResumptionRecord(BaseModel):
    """Persisted Gemini Live session resumption handle metadata."""

    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1)
    handle: str = Field(min_length=1)
    resumable: bool = True
    updated_at_ms: float = Field(ge=0.0)


class SessionStore:
    """Atomic JSON file store using temporary write + fsync + os.replace."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> SessionResumptionRecord | None:
        """Load the stored resumption record, or return None if absent."""
        if not self.path.exists():
            return None
        try:
            raw = self.path.read_text(encoding="utf-8")
            return SessionResumptionRecord.model_validate_json(raw)
        except (OSError, ValidationError, ValueError) as exc:
            raise SessionResumptionError(
                f"Failed to load session resumption handle from {self.path}: {exc}"
            ) from exc

    def save(self, record: SessionResumptionRecord) -> None:
        """Atomically persist a session resumption record via os.replace."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = record.model_dump_json(indent=2)
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=str(self.path.parent),
            )
            tmp_path = Path(tmp_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp_path, self.path)
            except Exception:
                if tmp_path.exists():
                    tmp_path.unlink(missing_ok=True)
                raise
        except OSError as exc:
            raise SessionResumptionError(
                f"Failed to atomically persist session resumption handle to {self.path}: {exc}"
            ) from exc

    def clear(self) -> None:
        """Remove the persisted session handle if present."""
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:
            raise SessionResumptionError(
                f"Failed to clear session resumption handle at {self.path}: {exc}"
            ) from exc


class SessionResumptionCoordinator:
    """Coordinates Gemini Live resumption handles, GoAway warnings, and reconnect backoff."""

    def __init__(
        self,
        store: SessionStore,
        session_id: str,
        *,
        base_delay_s: float = 0.5,
        max_delay_s: float = 16.0,
        max_attempts: int = 6,
    ) -> None:
        if base_delay_s <= 0 or max_delay_s < base_delay_s:
            raise SessionResumptionError("Invalid backoff bounds for SessionResumptionCoordinator")
        if max_attempts < 1:
            raise SessionResumptionError("max_attempts must be >= 1")

        self.store = store
        self.session_id = session_id
        self.base_delay_s = base_delay_s
        self.max_delay_s = max_delay_s
        self.max_attempts = max_attempts

        self._state: SessionState = "closed"
        self._attempt_count = 0
        self._resumption_count = 0
        existing = self.store.load()
        self._current_handle: str | None = (
            existing.handle if existing and existing.resumable else None
        )

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def attempt_count(self) -> int:
        return self._attempt_count

    @property
    def resumption_count(self) -> int:
        return self._resumption_count

    @property
    def current_handle(self) -> str | None:
        return self._current_handle

    def mark_connected(self) -> None:
        self._state = "connected"
        self._attempt_count = 0

    def mark_resumed(self) -> None:
        self._state = "resumed"
        self._attempt_count = 0
        self._resumption_count += 1

    def mark_closed(self) -> None:
        self._state = "closed"

    def mark_error(self) -> None:
        self._state = "error"

    def on_resumption_update(
        self,
        *,
        handle: str | None,
        resumable: bool = True,
        now_ms: float | None = None,
    ) -> None:
        """Persist new resumption handle from Gemini SessionResumptionUpdate."""
        timestamp_ms = now_ms if now_ms is not None else time.time() * 1000.0
        if not resumable or not handle:
            self._current_handle = None
            self.store.clear()
            return

        self._current_handle = handle
        self.store.save(
            SessionResumptionRecord(
                session_id=self.session_id,
                handle=handle,
                resumable=resumable,
                updated_at_ms=timestamp_ms,
            )
        )

    def _next_backoff_delay(self) -> float:
        if self._attempt_count >= self.max_attempts:
            raise SessionResumptionError(
                f"Exceeded max session resumption attempts ({self.max_attempts})"
            )
        delay = min(self.max_delay_s, self.base_delay_s * (2**self._attempt_count))
        self._attempt_count += 1
        return float(delay)

    def on_go_away(self, *, time_left_ms: float | None = None) -> float:
        """Record Gemini GoAway notice and compute proactive reconnect delay in seconds."""
        _ = time_left_ms
        self._state = "go_away"
        return self._next_backoff_delay()

    def on_disconnect(self) -> float:
        """Record unexpected disconnect and compute exponential backoff delay in seconds."""
        self._state = "reconnecting"
        return self._next_backoff_delay()

    def to_session_status(self, *, now_ms: float | None = None) -> SessionStatus:
        """Build a contract-compliant SessionStatus envelope."""
        timestamp_ms = now_ms if now_ms is not None else time.time() * 1000.0
        return SessionStatus(
            session_id=self.session_id,
            state=self._state,
            resumption_handle_present=self._current_handle is not None,
            timestamp_ms=timestamp_ms,
        )
