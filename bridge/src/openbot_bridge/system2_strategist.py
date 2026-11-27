"""System 2 Async Macro Strategist calling Gemini REST API periodically in the background."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Literal

import httpx
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

SYSTEM2_PROMPT = """You are OpenBot System 2 (strategic macro commander for OpenFront.io RTS).
Given an overview map frame (with 0.1..0.9 grid), HUD telemetry, and recent outcomes:
Output structured JSON CommanderDirective for the fast tactical AI:
- phase: spawn | early | mid | late (CRITICAL: when HUD shows panel=active, phase MUST be early,
  mid, or late — NEVER spawn!)
- priority_sectors: 1-3 short grid targets or sector names (e.g. "0.3,0.4 north neutral")
- target_enemies: 0-2 rival colors/regions to pressure
- ally_targets: 0-2 non-aggression or alliance candidates
- build_queue: 1-3 affordable structures/units for current HUD gold (defense_post 50K,
  city/port/factory 125K, warship 250K, atom_bomb 750K, missile_silo 1M, sam_launcher 1.5M)
- camera_goal: short cue like "overview" or "focus_0.25,0.75_coast"
- notes: <= 14 words tactical guidance"""

DIRECTIVE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "phase": {"type": "STRING", "enum": ["spawn", "early", "mid", "late"]},
        "priority_sectors": {"type": "ARRAY", "items": {"type": "STRING"}},
        "target_enemies": {"type": "ARRAY", "items": {"type": "STRING"}},
        "ally_targets": {"type": "ARRAY", "items": {"type": "STRING"}},
        "build_queue": {"type": "ARRAY", "items": {"type": "STRING"}},
        "camera_goal": {"type": "STRING"},
        "notes": {"type": "STRING"},
    },
    "required": [
        "phase",
        "priority_sectors",
        "target_enemies",
        "ally_targets",
        "build_queue",
        "camera_goal",
        "notes",
    ],
}


class CommanderDirective(BaseModel):
    """Structured strategic directive injected as a compact 2-line block into System 1."""

    model_config = ConfigDict(extra="ignore")

    phase: Literal["spawn", "early", "mid", "late"] = "early"
    priority_sectors: list[str] = Field(default_factory=lambda: ["nearest neutral frontier"])
    target_enemies: list[str] = Field(default_factory=list)
    ally_targets: list[str] = Field(default_factory=list)
    build_queue: list[str] = Field(default_factory=lambda: ["city", "port"])
    camera_goal: str = "overview"
    notes: str = "Expand aggressively on open borders; build economy when gold >= 125K."

    def to_prompt_block(self) -> str:
        """Render directive into strictly 2 compact lines for System 1 prompt injection."""
        sectors = ", ".join(self.priority_sectors[:3]) or "open frontier"
        enemies = ", ".join(self.target_enemies[:2]) or "none"
        allies = ", ".join(self.ally_targets[:2]) or "none"
        builds = ", ".join(self.build_queue[:3]) or "city"
        line1 = (
            f"[DIRECTIVE phase={self.phase}] priority={sectors} "
            f"enemies={enemies} allies={allies}"
        )
        line2 = f"[BUILD_CAMERA] build={builds} camera={self.camera_goal} note={self.notes[:90]}"
        return f"{line1}\n{line2}"


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(((pct / 100.0) * len(ordered)) - 0.0001)))
    return ordered[idx]


class System2Strategist:
    """Async background macro strategist with graceful degradation on API/network failures."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gemini-3.1-flash-lite-preview",
        timeout_s: float = 15.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s))

        self.current_directive = CommanderDirective()
        self.refreshes_succeeded = 0
        self.refreshes_failed = 0
        self.last_refresh_at_ms: float | None = None
        self.last_error: str | None = None
        self._latencies_ms: list[float] = []

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def stats(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "enabled": bool(self.api_key),
            "refreshes_succeeded": self.refreshes_succeeded,
            "refreshes_failed": self.refreshes_failed,
            "p50_ms": round(_percentile(self._latencies_ms, 50), 1),
            "p95_ms": round(_percentile(self._latencies_ms, 95), 1),
            "last_ms": round(self._latencies_ms[-1], 1) if self._latencies_ms else 0.0,
            "last_refresh_at_ms": self.last_refresh_at_ms,
            "current_phase": self.current_directive.phase,
            "last_error": self.last_error,
        }

    async def refresh_once(
        self,
        *,
        jpeg_bytes: bytes,
        hud_line: str,
        recent_outcomes: list[str],
    ) -> CommanderDirective:
        """Query Gemini REST generateContent for macro directive; retain last on error."""
        if not self.api_key:
            return self.current_directive

        started = time.perf_counter()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        b64_image = base64.b64encode(jpeg_bytes).decode("ascii")
        outcomes_text = " | ".join(recent_outcomes[-8:]) if recent_outcomes else "match start"
        prompt = f"{SYSTEM2_PROMPT}\n{hud_line}\nRecent outcomes: {outcomes_text}"

        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inlineData": {"mimeType": "image/jpeg", "data": b64_image}},
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": DIRECTIVE_RESPONSE_SCHEMA,
                "temperature": 0.2,
                "maxOutputTokens": 400,
                "thinkingConfig": {"thinkingLevel": "minimal"},
            },
        }

        try:
            resp = await self._client.post(
                url,
                headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict))
            directive = CommanderDirective.model_validate(json.loads(text))
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.current_directive = directive
            self.refreshes_succeeded += 1
            self.last_refresh_at_ms = time.time() * 1000.0
            self._latencies_ms.append(elapsed_ms)
            self.last_error = None
            logger.info(
                f"System 2 refreshed directive in {elapsed_ms:.0f}ms: "
                f"phase={directive.phase} builds={directive.build_queue}"
            )
            return directive
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}".strip(": ")
            self.refreshes_failed += 1
            self.last_error = err_msg
            logger.warning(f"System 2 strategist refresh failed (retaining last): {err_msg}")
            return self.current_directive
