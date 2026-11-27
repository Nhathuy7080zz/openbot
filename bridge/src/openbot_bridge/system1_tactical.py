"""System 1 Fast Tactical Loop client (LM Studio Gemma 4 no-think + optional Gemini Flash)."""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from loguru import logger

SYSTEM1_PROMPT = (
    "OpenFront RTS tactician. Image has 0.1..0.9 grid (top-left 0,0). "
    "Return compact JSON {r: <=5-word rationale, a: [{t,x,y,v?}]}. "
    "SPAWN (panel=spawn_or_hidden or phase=spawn): 1 select_spawn on open green land "
    "(no water/HUD). "
    "ACTIVE (panel=active): chain 3-5 ordered actions EVERY turn for high RTS tempo! "
    "Use expand_burst(x,y,v='0.06') on your expanding borders for 4-way rapid land grab, "
    "plus set_attack_ratio(v='35'..'50'), multiple attack_territory(x,y) strikes, and "
    "opportunistic build_structure when gold allows. "
    "CAMERA HYGIENE: if [CAMERA: zoomed_in] appears, ALWAYS include reset_overview(v='6') in a! "
    "Do NOT call focus_region right before build_structure in the same batch (zoom shifts coords); "
    "place builds directly on overview coords, or put focus_region LAST to inspect next turn. "
    "BUILD RULE: NEVER call build_structure unless HUD gold meets base cost: "
    "defense_post>=50K, city/port/factory>=125K, warship>=250K, atom_bomb>=750K, "
    "missile_silo>=1M, sam_launcher>=1.5M, hydrogen_bomb>=5M, mirv>=25M. Place builds strictly "
    "INSIDE your solid owned territory (near your spawn/center, never borders/water). NEVER "
    "repeat a failed (x,y) build coord! "
    "NEVER use wait_observe just for low gold - keep expanding borders with expand_burst "
    "unless troops<15% max or GAME_OVER."
)

_ALLOWED_TOOLS = (
    "select_spawn",
    "attack_territory",
    "set_attack_ratio",
    "build_structure",
    "launch_special",
    "diplomacy_action",
    "zoom_map",
    "pan_map",
    "focus_region",
    "reset_overview",
    "expand_burst",
    "wait_observe",
)

_ALLOWED_STRUCTURES = (
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
)

_ALLOWED_UNITS = ("warship", "atom_bomb", "hydrogen_bomb", "mirv")

_ALLOWED_DIPLOMACY = (
    "request_alliance",
    "break_alliance",
    "target_player",
    "donate_troops",
    "donate_gold",
    "embargo",
)

_ALLOWED_PAN = (
    "up",
    "down",
    "left",
    "right",
    "up_left",
    "up_right",
    "down_left",
    "down_right",
)

_THOUGHT_BLOCK_RE = re.compile(r"<\|thought\|>.*?<\|/thought\|>|<thought>.*?</thought>", re.DOTALL)

TACTICAL_JSON_SCHEMA: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "plan",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["r", "a"],
            "properties": {
                "r": {"type": "string"},
                "a": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["t", "x", "y"],
                        "properties": {
                            "t": {"type": "string", "enum": list(_ALLOWED_TOOLS)},
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "v": {"type": "string"},
                        },
                    },
                },
            },
        },
    },
}

GEMINI_SYSTEM1_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "r": {"type": "STRING"},
        "a": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "t": {"type": "STRING", "enum": list(_ALLOWED_TOOLS)},
                    "x": {"type": "NUMBER"},
                    "y": {"type": "NUMBER"},
                    "v": {"type": "STRING"},
                },
                "required": ["t", "x", "y"],
            },
        },
    },
    "required": ["r", "a"],
}


@dataclass(frozen=True)
class TacticalDecision:
    """Normalized tactical batch emitted by System 1 ready for execute_plan dispatch."""

    rationale: str
    actions: list[dict[str, Any]]
    inference_ms: float
    reasoning_tokens: int


def _clamp_coord(value: Any, default: float = 0.5) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return round(min(1.0, max(0.0, num)), 4)


def _clamp_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        num = round(float(value))
    except (TypeError, ValueError):
        return default
    return min(high, max(low, num))


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(((pct / 100.0) * len(ordered)) - 0.0001)))
    return ordered[idx]


def _normalize_sub_action(raw: Any, batch_rationale: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    tool = str(raw.get("t", raw.get("tool_name", ""))).strip()
    if tool not in _ALLOWED_TOOLS:
        return None

    v_raw = raw.get("v")
    v_str = str(v_raw).strip() if v_raw is not None else ""
    rationale = batch_rationale[:96] or "tactical move"

    if tool == "select_spawn":
        return {
            "tool_name": tool,
            "arguments": {
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "rationale": rationale,
            },
        }
    if tool == "attack_territory":
        args: dict[str, Any] = {
            "x": _clamp_coord(raw.get("x")),
            "y": _clamp_coord(raw.get("y")),
            "rationale": rationale,
        }
        mode = raw.get("mode") or (v_str if v_str in ("ground", "boat") else None)
        if mode in ("ground", "boat"):
            args["mode"] = mode
        if raw.get("ratio_pct") is not None:
            args["ratio_pct"] = _clamp_int(raw.get("ratio_pct"), 1, 100, 30)
        return {"tool_name": tool, "arguments": args}

    if tool == "set_attack_ratio":
        ratio_val = raw.get("ratio_pct") if raw.get("ratio_pct") is not None else v_str
        return {
            "tool_name": tool,
            "arguments": {
                "ratio_pct": _clamp_int(ratio_val, 1, 100, 30),
                "rationale": rationale,
            },
        }

    if tool == "build_structure":
        structure = str(raw.get("structure") or v_str).strip()
        if structure not in _ALLOWED_STRUCTURES:
            return None
        return {
            "tool_name": tool,
            "arguments": {
                "structure": structure,
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "rationale": rationale,
            },
        }

    if tool == "launch_special":
        unit = str(raw.get("unit") or v_str).strip()
        if unit not in _ALLOWED_UNITS:
            return None
        return {
            "tool_name": tool,
            "arguments": {
                "unit": unit,
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "rationale": rationale,
            },
        }

    if tool == "diplomacy_action":
        action = str(raw.get("action") or v_str).strip()
        if action not in _ALLOWED_DIPLOMACY:
            return None
        return {
            "tool_name": tool,
            "arguments": {
                "action": action,
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "rationale": rationale,
            },
        }

    if tool == "zoom_map":
        dir_cand = str(raw.get("direction") or v_str).strip()
        direction = dir_cand if dir_cand in ("in", "out") else "in"
        return {
            "tool_name": tool,
            "arguments": {
                "direction": direction,
                "steps": _clamp_int(raw.get("steps"), 1, 8, 2),
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "rationale": rationale,
            },
        }

    if tool == "pan_map":
        dir_cand = str(raw.get("direction") or v_str).strip()
        direction = dir_cand if dir_cand in _ALLOWED_PAN else "right"
        return {
            "tool_name": tool,
            "arguments": {
                "direction": direction,
                "duration_ms": _clamp_int(raw.get("duration_ms"), 100, 1200, 350),
                "rationale": rationale,
            },
        }

    if tool == "focus_region":
        zoom_raw = raw.get("zoom_steps", raw.get("steps", v_str or None))
        return {
            "tool_name": tool,
            "arguments": {
                "x": _clamp_coord(raw.get("x")),
                "y": _clamp_coord(raw.get("y")),
                "zoom_steps": _clamp_int(zoom_raw, 1, 6, 3),
                "rationale": rationale,
            },
        }

    if tool == "reset_overview":
        out_raw = raw.get("zoom_out_steps", raw.get("steps", v_str or None))
        return {
            "tool_name": tool,
            "arguments": {
                "zoom_out_steps": _clamp_int(out_raw, 1, 12, 6),
                "rationale": rationale,
            },
        }

    if tool == "expand_burst":
        spread_raw = raw.get("spread") if raw.get("spread") is not None else v_str
        try:
            spread_val = (
                round(min(0.15, max(0.02, float(spread_raw))), 3)
                if isinstance(spread_raw, (int, float, str)) and str(spread_raw).strip()
                else 0.06
            )
        except (TypeError, ValueError):
            spread_val = 0.06
        args = {
            "x": _clamp_coord(raw.get("x")),
            "y": _clamp_coord(raw.get("y")),
            "spread": spread_val,
            "count": _clamp_int(raw.get("count"), 3, 4, 4),
            "rationale": rationale,
        }
        if raw.get("ratio_pct") is not None:
            args["ratio_pct"] = _clamp_int(raw.get("ratio_pct"), 1, 100, 35)
        return {"tool_name": tool, "arguments": args}

    wait_raw = raw.get("duration_ms") if raw.get("duration_ms") is not None else v_str
    return {
        "tool_name": "wait_observe",
        "arguments": {
            "duration_ms": _clamp_int(wait_raw, 500, 2000, 500),
            "rationale": rationale,
        },
    }


def _strip_json_text(raw_text: str) -> str:
    cleaned = _THOUGHT_BLOCK_RE.sub("", raw_text).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.DOTALL).strip()
    return cleaned


class System1TacticalClient:
    """Stateless single-turn tactical inference client with persistent HTTP keep-alive."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:1234/v1",
        model: str = "google/gemma-4-12b",
        provider: Literal["lmstudio", "gemini"] = "lmstudio",
        gemini_api_key: str = "",
        gemini_model: str = "gemini-3.1-flash-lite-preview",
        timeout_s: float = 4.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.provider = provider
        self.gemini_api_key = gemini_api_key
        self.gemini_model = gemini_model
        self.timeout_s = timeout_s
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(retries=0),
            timeout=httpx.Timeout(timeout_s, connect=3.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )

        self.calls_total = 0
        self.calls_succeeded = 0
        self.calls_failed = 0
        self.reasoning_tokens_total = 0
        self.last_error: str | None = None
        self._latencies_ms: list[float] = []

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def stats(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model if self.provider == "lmstudio" else self.gemini_model,
            "calls_total": self.calls_total,
            "calls_succeeded": self.calls_succeeded,
            "calls_failed": self.calls_failed,
            "reasoning_tokens_total": self.reasoning_tokens_total,
            "p50_ms": round(_percentile(self._latencies_ms, 50), 1),
            "p95_ms": round(_percentile(self._latencies_ms, 95), 1),
            "last_ms": round(self._latencies_ms[-1], 1) if self._latencies_ms else 0.0,
            "last_error": self.last_error,
        }

    async def decide(
        self,
        *,
        jpeg_bytes: bytes,
        hud_line: str,
        directive_block: str,
        recent_outcomes: list[str],
    ) -> TacticalDecision | None:
        """Run one stateless vision -> tactical plan inference turn."""
        self.calls_total += 1
        started = time.perf_counter()
        b64_image = base64.b64encode(jpeg_bytes).decode("ascii")
        outcomes_text = "; ".join(recent_outcomes[-4:]) if recent_outcomes else "none"
        user_prompt = (
            f"{hud_line}\n"
            f"{directive_block}\n"
            f"[RECENT_OUTCOMES]: {outcomes_text}\n"
            "Next actions:"
        )

        try:
            if self.provider == "gemini":
                content_text, reasoning_tokens = await self._call_gemini(b64_image, user_prompt)
            else:
                content_text, reasoning_tokens = await self._call_lmstudio(b64_image, user_prompt)

            parsed = json.loads(_strip_json_text(content_text))
            raw_rat = str(parsed.get("r", parsed.get("rationale", "tactical push"))).strip()
            batch_rationale = raw_rat or "tactical push"
            raw_actions = parsed.get("a", parsed.get("actions", []))
            if not isinstance(raw_actions, list):
                raise ValueError("Missing 'a'/'actions' array in System 1 response")

            normalized: list[dict[str, Any]] = []
            for item in raw_actions[:5]:
                norm = _normalize_sub_action(item, batch_rationale)
                if norm is not None:
                    normalized.append(norm)

            if not normalized:
                raise ValueError("System 1 emitted zero valid normalized sub-actions")

            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.calls_succeeded += 1
            self.reasoning_tokens_total += reasoning_tokens
            self._latencies_ms.append(elapsed_ms)
            self.last_error = None
            return TacticalDecision(
                rationale=batch_rationale,
                actions=normalized,
                inference_ms=elapsed_ms,
                reasoning_tokens=reasoning_tokens,
            )
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}".strip(": ")
            self.calls_failed += 1
            self.last_error = err_msg
            logger.warning(f"System 1 tactical inference failed: {err_msg}")
            return None

    async def _call_lmstudio(self, b64_image: str, user_prompt: str) -> tuple[str, int]:
        payload: dict[str, Any] = {
            "model": self.model,
            "reasoning_effort": "none",
            "temperature": 0.15,
            "max_tokens": 220,
            "response_format": TACTICAL_JSON_SCHEMA,
            "messages": [
                {"role": "system", "content": SYSTEM1_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                        },
                    ],
                },
            ],
        }
        resp = await self._client.post(f"{self.base_url}/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = str(data["choices"][0]["message"]["content"])
        usage = data.get("usage") or {}
        details = usage.get("completion_tokens_details") or {}
        reasoning_tokens = int(details.get("reasoning_tokens", 0) or 0)
        return content, reasoning_tokens

    async def _call_gemini(self, b64_image: str, user_prompt: str) -> tuple[str, int]:
        if not self.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is required when OPENBOT_SYSTEM1_PROVIDER=gemini")
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.gemini_model}:generateContent"
        )
        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM1_PROMPT}]},
            "contents": [
                {
                    "parts": [
                        {"text": user_prompt},
                        {"inlineData": {"mimeType": "image/jpeg", "data": b64_image}},
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": GEMINI_SYSTEM1_RESPONSE_SCHEMA,
                "temperature": 0.15,
                "maxOutputTokens": 220,
                "thinkingConfig": {"thinkingLevel": "minimal"},
            },
        }
        resp = await self._client.post(
            url,
            headers={"x-goog-api-key": self.gemini_api_key, "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict))
        return text, 0
