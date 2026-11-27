import { describe, expect, it } from 'vitest';
import { ViewportError } from '../../src/errors/app-error.js';
import { CoordinateMapper, type CanvasRect } from '../../src/game/coordinate-mapper.js';

describe('CoordinateMapper', () => {
  const defaultRect: CanvasRect = { left: 100, top: 50, width: 1000, height: 500 };

  it('maps normalized [0..1] coordinates to viewport pixels and clamps edges inside rect', () => {
    const mapper = new CoordinateMapper(defaultRect);

    expect(mapper.toPixel(0, 0)).toEqual({ px: 100, py: 50 });
    expect(mapper.toPixel(0.5, 0.5)).toEqual({ px: 600, py: 300 });
    // x = 1.0 would be 1100 without clamping; must clamp to left + width - 1 = 1099
    expect(mapper.toPixel(1, 1)).toEqual({ px: 1099, py: 549 });
  });

  it('converts viewport pixels back to normalized [0..1] coordinates', () => {
    const mapper = new CoordinateMapper(defaultRect);

    expect(mapper.pixelToNormalized(100, 50)).toEqual({ x: 0, y: 0 });
    expect(mapper.pixelToNormalized(600, 300)).toEqual({ x: 0.5, y: 0.5 });
    expect(mapper.pixelToNormalized(1099, 549)).toEqual({ x: 0.999, y: 0.998 });
  });

  it('rejects out-of-range, NaN, and infinite normalized coordinates with ViewportError', () => {
    const mapper = new CoordinateMapper(defaultRect);

    expect(() => mapper.toPixel(-0.01, 0.5)).toThrow(ViewportError);
    expect(() => mapper.toPixel(1.01, 0.5)).toThrow(ViewportError);
    expect(() => mapper.toPixel(0.5, Number.NaN)).toThrow(ViewportError);
    expect(() => mapper.toPixel(Number.POSITIVE_INFINITY, 0.5)).toThrow(ViewportError);
    expect(() => mapper.pixelToNormalized(Number.NaN, 100)).toThrow(ViewportError);
  });

  it('rejects invalid CanvasRect dimensions', () => {
    expect(
      () => new CoordinateMapper({ left: 0, top: 0, width: 0, height: 500 }),
    ).toThrow(ViewportError);
    expect(
      () => new CoordinateMapper({ left: 0, top: 0, width: 500, height: -10 }),
    ).toThrow(ViewportError);
    expect(
      () => new CoordinateMapper({ left: Number.NaN, top: 0, width: 500, height: 500 }),
    ).toThrow(ViewportError);
  });

  it('tracks viewport resizes via updateRect and staleness via isStale', () => {
    let nowMs = 1000;
    const mapper = new CoordinateMapper(defaultRect, {
      maxAgeMs: 2000,
      now: () => nowMs,
    });

    expect(mapper.isStale()).toBe(false);
    expect(mapper.isStale({ ...defaultRect })).toBe(false);
    expect(mapper.isStale({ left: 0, top: 0, width: 1280, height: 720 })).toBe(true);

    nowMs = 3500;
    expect(mapper.isStale()).toBe(true);

    const updateResult = mapper.updateRect({ left: 0, top: 0, width: 1280, height: 720 });
    expect(updateResult.resized).toBe(true);
    expect(updateResult.previousRect).toEqual(defaultRect);
    expect(mapper.isStale()).toBe(false);
    expect(mapper.toPixel(0.5, 0.5)).toEqual({ px: 640, py: 360 });

    const noopUpdate = mapper.updateRect({ left: 0, top: 0, width: 1280, height: 720 });
    expect(noopUpdate.resized).toBe(false);
    expect(mapper.getRect()).toEqual({ left: 0, top: 0, width: 1280, height: 720 });

    mapper.markStale();
    expect(mapper.isStale()).toBe(true);
  });
});
