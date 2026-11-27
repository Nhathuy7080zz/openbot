"""Opt-in live Gemini API preflight smoke check (--live required)."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from google import genai  # noqa: E402
from google.genai.types import LiveConnectConfig, Modality  # noqa: E402

from openbot_bridge.config import load_config  # noqa: E402
from openbot_bridge.errors import BridgeConfigError  # noqa: E402


async def _run_live_smoke() -> int:
    cfg = load_config(require_api_key=True)
    print(f"Loaded config: {cfg.safe_summary()}")

    client = genai.Client(api_key=cfg.gemini_api_key, http_options={"api_version": "v1alpha"})
    models = list(client.models.list())
    live_matches = [m.name for m in models if m.name and "gemini" in m.name]
    print(f"models.list OK: {len(models)} total models ({len(live_matches)} Gemini models)")

    connect_config = LiveConnectConfig(response_modalities=[Modality.AUDIO])
    async with client.aio.live.connect(
        model=cfg.gemini_live_model,
        config=connect_config,
    ) as session:
        await session.send_realtime_input(text="Ping: respond briefly that OpenBot live check OK.")
        print(f"Gemini Live WSS handshake OK for model={cfg.gemini_live_model}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Opt-in live Gemini API preflight smoke test (never run during pytest)."
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Required flag to authorize real Gemini API network calls using GEMINI_API_KEY.",
    )
    args = parser.parse_args(argv)
    if not args.live:
        print("Refusing to call live Gemini API without --live flag.", file=sys.stderr)
        return 2

    try:
        return asyncio.run(_run_live_smoke())
    except BridgeConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
