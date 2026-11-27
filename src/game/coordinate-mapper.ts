import { ViewportError } from '../errors/app-error.js';

const NORMALIZED_MIN = 0;
const NORMALIZED_MAX = 1;
const DEFAULT_MAX_AGE_MS = 5000;

export interface CanvasRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelPoint {
  readonly px: number;
  readonly py: number;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface CoordinateMapperOptions {
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export interface RectUpdateResult {
  readonly resized: boolean;
  readonly previousRect: CanvasRect;
  readonly currentRect: CanvasRect;
}

function assertValidRect(rect: CanvasRect): CanvasRect {
  const { left, top, width, height } = rect;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new ViewportError('CanvasRect values must be finite numbers', rect);
  }
  if (width <= 0 || height <= 0) {
    throw new ViewportError('CanvasRect width and height must be positive', rect);
  }
  return { left, top, width, height };
}

function assertNormalizedCoord(value: number, axis: 'x' | 'y'): void {
  if (!Number.isFinite(value)) {
    throw new ViewportError(`Normalized coordinate ${axis} must be finite`, { axis, value });
  }
  if (value < NORMALIZED_MIN || value > NORMALIZED_MAX) {
    throw new ViewportError(
      `Normalized coordinate ${axis}=${value} is outside [${NORMALIZED_MIN}..${NORMALIZED_MAX}]`,
      { axis, value },
    );
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectsEqual(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * Maps normalized [0..1] game coordinates to live viewport pixel coordinates and tracks resize staleness.
 */
export class CoordinateMapper {
  private rect: CanvasRect;
  private lastUpdatedAtMs: number;
  private staleFlag = false;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(initialRect: CanvasRect, options: CoordinateMapperOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.rect = assertValidRect(initialRect);
    this.lastUpdatedAtMs = this.now();
  }

  getRect(): CanvasRect {
    return { ...this.rect };
  }

  updateRect(nextRect: CanvasRect): RectUpdateResult {
    const validated = assertValidRect(nextRect);
    const previousRect = this.getRect();
    const resized = !rectsEqual(previousRect, validated);
    this.rect = validated;
    this.lastUpdatedAtMs = this.now();
    this.staleFlag = false;
    return {
      resized,
      previousRect,
      currentRect: this.getRect(),
    };
  }

  markStale(): void {
    this.staleFlag = true;
  }

  isStale(liveRect?: CanvasRect): boolean {
    if (this.staleFlag) {
      return true;
    }
    if (this.now() - this.lastUpdatedAtMs > this.maxAgeMs) {
      return true;
    }
    if (liveRect !== undefined) {
      const validated = assertValidRect(liveRect);
      if (!rectsEqual(this.rect, validated)) {
        return true;
      }
    }
    return false;
  }

  toPixel(x: number, y: number): PixelPoint {
    assertNormalizedCoord(x, 'x');
    assertNormalizedCoord(y, 'y');

    const maxPx = this.rect.left + this.rect.width - 1;
    const maxPy = this.rect.top + this.rect.height - 1;

    const rawPx = Math.round(this.rect.left + x * this.rect.width);
    const rawPy = Math.round(this.rect.top + y * this.rect.height);

    return {
      px: clampNumber(rawPx, this.rect.left, maxPx),
      py: clampNumber(rawPy, this.rect.top, maxPy),
    };
  }

  pixelToNormalized(px: number, py: number): NormalizedPoint {
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      throw new ViewportError('Pixel coordinates must be finite numbers', { px, py });
    }

    const rawX = (px - this.rect.left) / this.rect.width;
    const rawY = (py - this.rect.top) / this.rect.height;

    return {
      x: clampNumber(rawX, NORMALIZED_MIN, NORMALIZED_MAX),
      y: clampNumber(rawY, NORMALIZED_MIN, NORMALIZED_MAX),
    };
  }
}
