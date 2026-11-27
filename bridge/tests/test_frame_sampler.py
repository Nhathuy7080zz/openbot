"""TDD tests for OneFpsFrameSampler and MonotonicFrameGate."""

from __future__ import annotations

import io
from typing import Any

import pytest
from PIL import Image, ImageDraw
from pipecat.frames.frames import Frame, InputImageRawFrame, TextFrame, UserImageRawFrame
from pipecat.processors.frame_processor import FrameDirection

from openbot_bridge.frame_sampler import (
    MonotonicFrameGate,
    OneFpsFrameSampler,
    downscale_and_encode_frame,
)


def _make_rgb_bytes(width: int, height: int, color: tuple[int, int, int] = (40, 80, 120)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, max(1, width // 2), max(1, height // 2)), fill=(200, 220, 240))
    return img.tobytes()


def test_monotonic_frame_gate_enforces_one_fps() -> None:
    now = 100.0
    gate = MonotonicFrameGate(max_fps=1.0, monotonic_fn=lambda: now)

    assert gate.should_accept() is True
    assert gate.accepted_count == 1
    assert gate.dropped_count == 0

    now = 100.2
    assert gate.should_accept() is False
    assert gate.accepted_count == 1
    assert gate.dropped_count == 1

    now = 100.999
    assert gate.should_accept() is False
    assert gate.dropped_count == 2

    now = 101.0
    assert gate.should_accept() is True
    assert gate.accepted_count == 2
    assert gate.dropped_count == 2


def test_downscale_and_encode_frame_resizes_and_produces_valid_jpeg() -> None:
    raw = _make_rgb_bytes(1920, 1080)
    resized_bytes, new_size, jpeg_bytes = downscale_and_encode_frame(
        raw,
        size=(1920, 1080),
        fmt="RGB",
        max_dimension=960,
        encode_jpeg=True,
        jpeg_quality=80,
    )
    assert new_size == (960, 540)
    assert len(resized_bytes) == 960 * 540 * 3
    assert jpeg_bytes is not None
    assert jpeg_bytes.startswith(b"\xff\xd8")
    decoded = Image.open(io.BytesIO(jpeg_bytes))
    assert decoded.size == (960, 540)


@pytest.mark.asyncio
async def test_one_fps_frame_sampler_drops_excess_and_records_timestamp() -> None:
    mono_now = 50.0
    wall_now_ms = 1_700_000_000_000.0

    sampler = OneFpsFrameSampler(
        max_fps=1.0,
        max_dimension=640,
        encode_jpeg=True,
        monotonic_fn=lambda: mono_now,
        wall_ms_fn=lambda: wall_now_ms,
    )

    pushed: list[tuple[Frame, FrameDirection]] = []

    async def fake_push_frame(
        frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        pushed.append((frame, direction))

    sampler.push_frame = fake_push_frame  # type: ignore[method-assign]

    frame1 = UserImageRawFrame(image=_make_rgb_bytes(1280, 720), size=(1280, 720), format="RGB")
    await sampler.process_frame(frame1, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 1
    out1 = pushed[0][0]
    assert isinstance(out1, InputImageRawFrame)
    assert out1.size == (640, 360)
    assert sampler.last_frame_captured_at_ms == wall_now_ms
    assert sampler.last_jpeg_bytes is not None
    assert sampler.last_jpeg_bytes.startswith(b"\xff\xd8")

    mono_now = 50.3
    wall_now_ms = 1_700_000_000_300.0
    frame2 = UserImageRawFrame(image=_make_rgb_bytes(1280, 720), size=(1280, 720), format="RGB")
    await sampler.process_frame(frame2, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 1
    assert sampler.gate.dropped_count == 1
    assert sampler.last_frame_captured_at_ms == 1_700_000_000_000.0

    text_frame = TextFrame(text="hello")
    await sampler.process_frame(text_frame, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 2
    assert pushed[1][0] is text_frame

    mono_now = 51.05
    wall_now_ms = 1_700_000_001_050.0
    frame3 = InputImageRawFrame(image=_make_rgb_bytes(640, 360), size=(640, 360), format="RGB")
    await sampler.process_frame(frame3, FrameDirection.DOWNSTREAM)
    assert len(pushed) == 3
    assert sampler.last_frame_captured_at_ms == 1_700_000_001_050.0
    stats: dict[str, Any] = sampler.stats()
    assert stats["accepted_frames"] == 2
    assert stats["dropped_frames"] == 1
