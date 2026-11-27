"""In-memory frame downscaling, blank-frame rejection, and 0.1-0.9 coordinate grid overlay."""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

MIN_LUMA_THRESHOLD = 4.0
GRID_TICKS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)


@dataclass(frozen=True)
class PreparedFrame:
    """Grid-annotated JPEG frame ready for vision inference."""

    jpeg_bytes: bytes
    width: int
    height: int
    mean_luma: float


def prepare_tactical_frame(
    jpeg_bytes: bytes,
    *,
    width: int = 960,
    height: int = 540,
    quality: int = 68,
    debug_frame_path: Path | None = None,
) -> PreparedFrame | None:
    """Resize viewport frame, reject blanks, burn 0.1-0.9 grid overlay, re-encode JPEG."""
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as img:
            rgb = img.convert("RGB")
            mean_luma = float(ImageStat.Stat(rgb.convert("L")).mean[0])
            if mean_luma < MIN_LUMA_THRESHOLD:
                return None

            resized = rgb.resize((width, height), Image.Resampling.BILINEAR)
            annotated = _draw_coordinate_grid(resized)

            if debug_frame_path is not None:
                debug_frame_path.parent.mkdir(parents=True, exist_ok=True)
                annotated.save(debug_frame_path, format="PNG")

            out_buf = io.BytesIO()
            annotated.save(out_buf, format="JPEG", quality=quality, optimize=True)
            return PreparedFrame(
                jpeg_bytes=out_buf.getvalue(),
                width=width,
                height=height,
                mean_luma=mean_luma,
            )
    except (OSError, ValueError):
        return None


def _draw_coordinate_grid(image: Image.Image) -> Image.Image:
    width, height = image.size
    base = image.convert("RGBA")
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    line_color = (255, 255, 255, 72)
    major_color = (255, 235, 90, 105)
    label_bg = (10, 14, 20, 195)
    label_fg = (255, 255, 255, 245)

    for tick in GRID_TICKS:
        px = round(tick * width)
        py = round(tick * height)
        is_center = abs(tick - 0.5) < 1e-6
        col = major_color if is_center else line_color

        draw.line([(px, 0), (px, height)], fill=col, width=1)
        draw.line([(0, py), (width, py)], fill=col, width=1)

        label = f"{tick:.1f}"
        # Top X-axis badge
        draw.rectangle([px + 2, 2, px + 26, 15], fill=label_bg)
        draw.text((px + 4, 3), label, fill=label_fg)

        # Left Y-axis badge
        draw.rectangle([2, py + 2, 26, py + 15], fill=label_bg)
        draw.text((4, py + 3), label, fill=label_fg)

    # Subtle intersection crosshairs so target coordinates stand out visually
    cross_color = (255, 255, 255, 115)
    for tx in (0.2, 0.4, 0.5, 0.6, 0.8):
        for ty in (0.2, 0.4, 0.5, 0.6, 0.8):
            cx = round(tx * width)
            cy = round(ty * height)
            draw.line([(cx - 4, cy), (cx + 4, cy)], fill=cross_color, width=1)
            draw.line([(cx, cy - 4), (cx, cy + 4)], fill=cross_color, width=1)

    return Image.alpha_composite(base, overlay).convert("RGB")
