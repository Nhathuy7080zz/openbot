"""TDD tests for atomic session store and exponential backoff resumption coordinator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openbot_bridge.errors import SessionResumptionError
from openbot_bridge.session_store import (
    SessionResumptionCoordinator,
    SessionResumptionRecord,
    SessionStore,
)


def test_session_store_atomic_write_and_reload(tmp_path: Path) -> None:
    store_path = tmp_path / "nested" / "session.json"
    store = SessionStore(store_path)

    assert store.load() is None

    record = SessionResumptionRecord(
        session_id="sess-123",
        handle="resume-handle-abc",
        resumable=True,
        updated_at_ms=1_700_000_000_000.0,
    )
    store.save(record)

    assert store_path.exists()
    # Ensure no leftover temporary files remain after os.replace
    leftovers = [p for p in store_path.parent.iterdir() if p.name != store_path.name]
    assert leftovers == []

    loaded = store.load()
    assert loaded == record


def test_session_store_rejects_corrupt_json(tmp_path: Path) -> None:
    store_path = tmp_path / "session.json"
    store_path.write_text("{corrupt", encoding="utf-8")
    store = SessionStore(store_path)

    with pytest.raises(SessionResumptionError):
        store.load()


def test_session_store_clear_removes_file(tmp_path: Path) -> None:
    store_path = tmp_path / "session.json"
    store = SessionStore(store_path)
    store.save(
        SessionResumptionRecord(
            session_id="sess-1",
            handle="h-1",
            resumable=True,
            updated_at_ms=10.0,
        )
    )
    assert store_path.exists()
    store.clear()
    assert not store_path.exists()
    # Idempotent clear
    store.clear()


def test_coordinator_handles_updates_go_away_and_exponential_backoff(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "session.json")
    coord = SessionResumptionCoordinator(
        store=store,
        session_id="sess-1",
        base_delay_s=0.5,
        max_delay_s=4.0,
        max_attempts=4,
    )

    assert coord.current_handle is None
    assert coord.state == "closed"

    coord.mark_connected()
    assert coord.state == "connected"

    coord.on_resumption_update(handle="handle-1", resumable=True, now_ms=1000.0)
    assert coord.current_handle == "handle-1"
    raw = json.loads((tmp_path / "session.json").read_text(encoding="utf-8"))
    assert raw["handle"] == "handle-1"

    delay1 = coord.on_go_away(time_left_ms=5000.0)
    assert coord.state == "go_away"
    assert delay1 == pytest.approx(0.5)

    delay2 = coord.on_disconnect()
    assert coord.state == "reconnecting"
    assert delay2 == pytest.approx(1.0)

    delay3 = coord.on_disconnect()
    assert delay3 == pytest.approx(2.0)

    delay4 = coord.on_disconnect()
    assert delay4 == pytest.approx(4.0)

    with pytest.raises(SessionResumptionError):
        coord.on_disconnect()

    coord.mark_resumed()
    assert coord.state == "resumed"
    assert coord.attempt_count == 0
