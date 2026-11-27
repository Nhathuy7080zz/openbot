"""TDD tests for non-blank/frozen frame health checking and debug-frame export."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from pipecat.frames.frames import InputImageRawFrame, TextFrame
from pipecat.processors.frame_processor import FrameDirection

from openbot_bridge.frame_sampler import FrameHealthChecker, OneFpsFrameSampler


def _make_rgb_bytes(width: int, height: int, *, pattern: str) -> bytes:
    img = Image.new("RGB", (width, height), (0, 0, 0))
    if pattern == "black":
        return img.tobytes()
    if pattern == "flat_gray":
        img = Image.new("RGB", (width, height), (40, 40, 40))
        return img.tobytes()
    if pattern == "map_hud":
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, width, height], fill=(18, 45, 72))
        draw.polygon([(40, 40), (140, 30), (160, 120), (30, 130)], fill=(70, 180, 90))
        draw.rectangle([0, height - 30, width, height], fill=(25, 25, 30))
        draw.text((10, height - 22), "GOLD 1200 | TROOPS 45K | 20%", fill=(255, 220, 90))
        return img.tobytes()
    raise ValueError(pattern)


def test_frame_health_checker_rejects_black_and_flat_frames() -> None:
    checker = FrameHealthChecker(frozen_threshold=3)

    black = _make_rgb_bytes(160, 90, pattern="black")
    res_black = checker.inspect_rgb(black, size=(160, 90))
    assert res_black.is_valid is False
    assert res_black.reason == "blank_or_black"

    flat = _make_rgb_bytes(160, 90, pattern="flat_gray")
    res_flat = checker.inspect_rgb(flat, size=(160, 90))
    assert res_flat.is_valid is False
    assert res_flat.reason == "flat_uniform"


def test_frame_health_checker_accepts_map_hud_and_flags_frozen_frames() -> None:
    checker = FrameHealthChecker(frozen_threshold=3)
    valid_bytes = _make_rgb_bytes(200, 120, pattern="map_hud")

    r1 = checker.inspect_rgb(valid_bytes, size=(200, 120))
    r2 = checker.inspect_rgb(valid_bytes, size=(200, 120))
    r3 = checker.inspect_rgb(valid_bytes, size=(200, 120))

    assert r1.is_valid is True and r1.is_frozen is False
    assert r2.is_valid is True and r2.is_frozen is False
    assert r3.is_valid is True and r3.is_frozen is True
    assert checker.frozen_frames_warned == 1


@pytest.mark.asyncio
async def test_one_fps_sampler_drops_black_frames_and_writes_debug_png(tmp_path: Path) -> None:
    now_s = [10.0]
    debug_png = tmp_path / "artifacts" / "debug-frame.png"
    sampler = OneFpsFrameSampler(
        max_fps=1.0,
        monotonic_fn=lambda: now_s[0],
        wall_ms_fn=lambda: now_s[0] * 1000.0,
        debug_frame_path=debug_png,
    )

    pushed: list[object] = []

    async def fake_push(
        frame: object, _direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        pushed.append(frame)

    sampler.push_frame = fake_push  # type: ignore[method-assign]

    # Black frame should be rejected before debug_png is written
    black_frame = InputImageRawFrame(
        image=_make_rgb_bytes(160, 90, pattern="black"),
        size=(160, 90),
        format="RGB",
    )
    await sampler.process_frame(black_frame, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 0
    assert sampler.stats()["blank_frames_rejected"] == 1
    assert not debug_png.exists()

    # Non-image frame passes through untouched
    await sampler.process_frame(TextFrame("ok"), FrameDirection.DOWNSTREAM)
    assert len(pushed) == 1

    # Valid map+HUD frame at next second passes and writes debug PNG
    now_s[0] = 11.2
    valid_frame = InputImageRawFrame(
        image=_make_rgb_bytes(200, 120, pattern="map_hud"),
        size=(200, 120),
        format="RGB",
    )
    await sampler.process_frame(valid_frame, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 2
    assert debug_png.exists()
    with Image.open(io.BytesIO(debug_png.read_bytes())) as saved:
        assert saved.format == "PNG"
        assert saved.size == (200, 120)
