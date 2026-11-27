"""1 FPS monotonic frame sampler, non-blank/frozen health check, and debug PNG export."""

from __future__ import annotations

import hashlib
import io
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger
from PIL import Image, ImageStat
from pipecat.frames.frames import Frame, InputImageRawFrame, UserImageRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass(frozen=True)
class FrameHealthResult:
    """Result of inspecting a single RGB frame for blank/black or frozen anomalies."""

    is_valid: bool
    reason: str | None
    mean_luma: float
    max_luma: float
    std_luma: float
    is_frozen: bool
    digest: str


class FrameHealthChecker:
    """Validates decoded video frames against all-black, flat-uniform, and frozen streams."""

    def __init__(
        self,
        *,
        min_max_luma: float = 8.0,
        min_std_luma: float = 2.0,
        frozen_threshold: int = 10,
    ) -> None:
        if frozen_threshold < 2:
            raise ValueError(f"frozen_threshold must be >= 2, got {frozen_threshold}")
        self.min_max_luma = min_max_luma
        self.min_std_luma = min_std_luma
        self.frozen_threshold = frozen_threshold
        self.blank_frames_rejected = 0
        self.frozen_frames_warned = 0
        self.valid_frames_accepted = 0
        self._last_digest: str | None = None
        self._identical_streak = 0

    def inspect_rgb(self, rgb_bytes: bytes, *, size: tuple[int, int]) -> FrameHealthResult:
        """Analyze RGB image bytes for brightness, contrast, and repeated frame freeze."""
        image = Image.frombytes("RGB", size, rgb_bytes)
        luma = image.convert("L")
        stat = ImageStat.Stat(luma)
        mean_luma = float(stat.mean[0])
        std_luma = float(stat.stddev[0])
        _min_luma, max_luma = stat.extrema[0]
        max_luma_f = float(max_luma)
        digest = hashlib.sha256(rgb_bytes).hexdigest()

        if max_luma_f < self.min_max_luma:
            self.blank_frames_rejected += 1
            return FrameHealthResult(
                is_valid=False,
                reason="blank_or_black",
                mean_luma=mean_luma,
                max_luma=max_luma_f,
                std_luma=std_luma,
                is_frozen=False,
                digest=digest,
            )

        if std_luma < self.min_std_luma:
            self.blank_frames_rejected += 1
            return FrameHealthResult(
                is_valid=False,
                reason="flat_uniform",
                mean_luma=mean_luma,
                max_luma=max_luma_f,
                std_luma=std_luma,
                is_frozen=False,
                digest=digest,
            )

        self.valid_frames_accepted += 1
        if digest == self._last_digest:
            self._identical_streak += 1
        else:
            self._last_digest = digest
            self._identical_streak = 1

        is_frozen = self._identical_streak >= self.frozen_threshold
        if is_frozen and self._identical_streak == self.frozen_threshold:
            self.frozen_frames_warned += 1
            logger.warning(
                f"Detected frozen video capture ({self._identical_streak} identical frames)"
            )

        return FrameHealthResult(
            is_valid=True,
            reason=None,
            mean_luma=mean_luma,
            max_luma=max_luma_f,
            std_luma=std_luma,
            is_frozen=is_frozen,
            digest=digest,
        )


class MonotonicFrameGate:
    """Monotonic clock gate ensuring at most max_fps frames are accepted."""

    def __init__(
        self,
        *,
        max_fps: float = 1.0,
        monotonic_fn: Callable[[], float] | None = None,
    ) -> None:
        if max_fps <= 0.0:
            raise ValueError(f"max_fps must be > 0, got {max_fps}")
        self.max_fps = max_fps
        self._min_interval_s = 1.0 / max_fps
        self._monotonic_fn: Callable[[], float] = monotonic_fn or time.monotonic
        self._last_accepted_at: float | None = None
        self.accepted_count = 0
        self.dropped_count = 0

    def should_accept(self) -> bool:
        """Return True if enough monotonic time has elapsed since the last accepted frame."""
        now = self._monotonic_fn()
        if self._last_accepted_at is None or (now - self._last_accepted_at) >= self._min_interval_s:
            self._last_accepted_at = now
            self.accepted_count += 1
            return True
        self.dropped_count += 1
        return False


def downscale_and_encode_frame(
    raw_bytes: bytes,
    *,
    size: tuple[int, int],
    fmt: str | None,
    max_dimension: int | None = 1280,
    encode_jpeg: bool = False,
    jpeg_quality: int = 85,
) -> tuple[bytes, tuple[int, int], bytes | None]:
    """Convert raw pixel bytes to RGB, optionally downscale, and optionally encode JPEG."""
    mode = fmt or "RGB"
    image = Image.frombytes(mode, size, raw_bytes)
    if image.mode != "RGB":
        image = image.convert("RGB")

    width, height = image.size
    if max_dimension is not None and max_dimension > 0 and max(width, height) > max_dimension:
        scale = max_dimension / float(max(width, height))
        target_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(target_size, Image.Resampling.BILINEAR)

    rgb_bytes = image.tobytes()
    jpeg_bytes: bytes | None = None
    if encode_jpeg:
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=jpeg_quality)
        jpeg_bytes = buf.getvalue()

    return rgb_bytes, image.size, jpeg_bytes


def _write_png_atomic(rgb_bytes: bytes, size: tuple[int, int], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    image = Image.frombytes("RGB", size, rgb_bytes)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=str(target.parent),
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            image.save(fh, format="PNG")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, target)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


class OneFpsFrameSampler(FrameProcessor):
    """Pipecat FrameProcessor enforcing 1 FPS gating, non-blank validation, and timestamping."""

    def __init__(
        self,
        *,
        max_fps: float = 1.0,
        max_dimension: int | None = 1280,
        encode_jpeg: bool = False,
        jpeg_quality: int = 85,
        monotonic_fn: Callable[[], float] | None = None,
        wall_ms_fn: Callable[[], float] | None = None,
        debug_frame_path: Path | None = None,
        health_checker: FrameHealthChecker | None = None,
        name: str | None = None,
    ) -> None:
        super().__init__(name=name or "OneFpsFrameSampler")
        self.gate = MonotonicFrameGate(max_fps=max_fps, monotonic_fn=monotonic_fn)
        self.health_checker = health_checker or FrameHealthChecker()
        self.max_dimension = max_dimension
        self.encode_jpeg = encode_jpeg
        self.jpeg_quality = jpeg_quality
        self._wall_ms_fn: Callable[[], float] = wall_ms_fn or (lambda: time.time() * 1000.0)
        self.debug_frame_path = debug_frame_path
        self._debug_frame_saved = False
        self.last_frame_captured_at_ms: float | None = None
        self.last_jpeg_bytes: bytes | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Gate downstream video frames to max_fps, reject blank frames, and forward."""
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, InputImageRawFrame):
            if not self.gate.should_accept():
                return

            rgb_bytes, new_size, jpeg_bytes = downscale_and_encode_frame(
                frame.image,
                size=frame.size,
                fmt=frame.format,
                max_dimension=self.max_dimension,
                encode_jpeg=self.encode_jpeg,
                jpeg_quality=self.jpeg_quality,
            )

            health = self.health_checker.inspect_rgb(rgb_bytes, size=new_size)
            if not health.is_valid:
                logger.warning(
                    f"Rejected invalid video frame ({health.reason}, "
                    f"max_luma={health.max_luma:.1f}, std_luma={health.std_luma:.2f})"
                )
                return

            self.last_frame_captured_at_ms = float(self._wall_ms_fn())
            self.last_jpeg_bytes = jpeg_bytes

            if self.debug_frame_path is not None and not self._debug_frame_saved:
                try:
                    _write_png_atomic(rgb_bytes, new_size, self.debug_frame_path)
                    self._debug_frame_saved = True
                    logger.info(f"Saved non-blank debug capture frame to {self.debug_frame_path}")
                except OSError as exc:
                    logger.warning(f"Failed to save debug frame PNG: {exc}")

            out_frame: InputImageRawFrame
            if isinstance(frame, UserImageRawFrame):
                out_frame = UserImageRawFrame(
                    image=rgb_bytes,
                    size=new_size,
                    format="RGB",
                    user_id=frame.user_id,
                    text=frame.text,
                    append_to_context=frame.append_to_context,
                    request=frame.request,
                    run_llm=frame.run_llm,
                )
            else:
                out_frame = InputImageRawFrame(
                    image=rgb_bytes,
                    size=new_size,
                    format="RGB",
                )
            await self.push_frame(out_frame, direction)
            return

        await self.push_frame(frame, direction)

    def stats(self) -> dict[str, Any]:
        """Return frame sampler and health telemetry counters."""
        return {
            "max_fps": self.gate.max_fps,
            "accepted_frames": self.gate.accepted_count,
            "dropped_frames": self.gate.dropped_count,
            "valid_frames_accepted": self.health_checker.valid_frames_accepted,
            "blank_frames_rejected": self.health_checker.blank_frames_rejected,
            "frozen_frames_warned": self.health_checker.frozen_frames_warned,
            "debug_frame_saved": self._debug_frame_saved,
            "last_frame_captured_at_ms": self.last_frame_captured_at_ms,
        }
