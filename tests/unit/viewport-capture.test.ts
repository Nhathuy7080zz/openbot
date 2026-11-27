import { describe, expect, it, vi } from 'vitest';
import { ViewportCapture, type ScreencastTransportClient } from '../../src/browser/viewport-capture.js';
import { ActuatorError } from '../../src/errors/app-error.js';

describe('ViewportCapture', () => {
  it('captures composited JPEG viewport frames and forwards binary buffers over frame sink', async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const captureScreenshot = vi.fn().mockResolvedValue({
      data: fakeJpeg.toString('base64'),
    });
    const client: ScreencastTransportClient = {
      Page: { captureScreenshot },
      close: vi.fn().mockResolvedValue(undefined),
    };

    const sentFrames: Buffer[] = [];
    const capture = new ViewportCapture({
      client,
      fps: 2,
      onFrame: (buf) => {
        sentFrames.push(buf);
      },
    });

    const captured = await capture.captureOnce();
    expect(captured.equals(fakeJpeg)).toBe(true);
    expect(sentFrames).toHaveLength(1);
    expect(captureScreenshot).toHaveBeenCalledWith({
      format: 'jpeg',
      quality: 70,
      fromSurface: true,
      optimizeForSpeed: true,
    });
    expect(capture.getStats().capturedFrames).toBe(1);
    await capture.stop();
  });

  it('rejects empty screenshot payloads and counts errors without crashing loop', async () => {
    const client: ScreencastTransportClient = {
      Page: {
        captureScreenshot: vi.fn().mockResolvedValue({ data: '' }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    const capture = new ViewportCapture({ client, fps: 1 });
    await expect(capture.captureOnce()).rejects.toThrow(ActuatorError);
    expect(capture.getStats().failedFrames).toBe(1);
  });

  it('acks every CDP screencastFrame and throttles emitted frames to configured FPS', async () => {
    let fakeNow = 1_000;
    const ackCalls: Array<{ sessionId: number }> = [];
    const startScreencast = vi.fn().mockResolvedValue(undefined);
    const stopScreencast = vi.fn().mockResolvedValue(undefined);
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

    const client: ScreencastTransportClient = {
      Page: {
        captureScreenshot: vi.fn().mockResolvedValue({ data: '' }),
        startScreencast,
        stopScreencast,
        screencastFrameAck: vi.fn((params: { sessionId: number }) => {
          ackCalls.push(params);
          return Promise.resolve();
        }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    const emitted: Buffer[] = [];
    const capture = new ViewportCapture({
      client,
      fps: 1, // 1000ms interval
      now: () => fakeNow,
      onFrame: (buf) => {
        emitted.push(buf);
      },
    });

    const mode = await capture.startScreencastOrFallback();
    expect(mode).toBe('screencast');
    expect(capture.getStats().mode).toBe('screencast');

    const accepted1 = await capture.handleScreencastFrame({
      data: fakeJpeg.toString('base64'),
      sessionId: 101,
    });
    expect(accepted1).toBe(true);
    expect(emitted).toHaveLength(1);

    // 400ms later -> throttled, still acked
    fakeNow += 400;
    const dropped = await capture.handleScreencastFrame({
      data: fakeJpeg.toString('base64'),
      sessionId: 102,
    });
    expect(dropped).toBe(false);
    expect(emitted).toHaveLength(1);

    // +700ms (total 1100ms >= 1000ms) -> accepted
    fakeNow += 700;
    const accepted2 = await capture.handleScreencastFrame({
      data: fakeJpeg.toString('base64'),
      sessionId: 103,
    });
    expect(accepted2).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(ackCalls).toEqual([{ sessionId: 101 }, { sessionId: 102 }, { sessionId: 103 }]);

    await capture.stop();
    expect(stopScreencast).toHaveBeenCalledTimes(1);
  });

  it('rejects stalled captureScreenshot calls after timeout without wedging', async () => {
    vi.useFakeTimers();
    try {
      const client: ScreencastTransportClient = {
        Page: {
          captureScreenshot: vi.fn(() => new Promise<{ data: string }>(() => undefined)),
        },
        close: vi.fn().mockResolvedValue(undefined),
      };

      const capture = new ViewportCapture({ client, fps: 1 });
      const capturePromise = capture.captureOnce();
      const expectation = expect(capturePromise).rejects.toThrow(ActuatorError);
      await vi.advanceTimersByTimeAsync(3_100);
      await expectation;
      expect(capture.getStats().failedFrames).toBe(1);
      expect(capture.getStats().stalledFrames).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts stale screencast twice and falls back to low-frequency polling after persistent stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
      const captureScreenshot = vi.fn().mockResolvedValue({
        data: fakeJpeg.toString('base64'),
      });
      const startScreencast = vi.fn().mockResolvedValue(undefined);
      const stopScreencast = vi.fn().mockResolvedValue(undefined);
      const bringToFront = vi.fn().mockResolvedValue(undefined);
      const sentFrames: Buffer[] = [];

      const client: ScreencastTransportClient = {
        Page: {
          captureScreenshot,
          startScreencast,
          stopScreencast,
          bringToFront,
          screencastFrameAck: vi.fn().mockResolvedValue(undefined),
        },
        close: vi.fn().mockResolvedValue(undefined),
      };

      const capture = new ViewportCapture({
        client,
        fps: 2,
        now: () => Date.now(),
        onFrame: (buf) => {
          sentFrames.push(buf);
        },
      });

      const mode = await capture.startScreencastOrFallback();
      expect(mode).toBe('screencast');
      expect(startScreencast).toHaveBeenCalledTimes(1);

      await capture.handleScreencastFrame({
        data: fakeJpeg.toString('base64'),
        sessionId: 1,
      });
      expect(sentFrames).toHaveLength(1);
      expect(capture.getStats().mode).toBe('screencast');

      // Stale check 1 & 2 (every 4s) restart screencast before giving up on poll fallback.
      await vi.advanceTimersByTimeAsync(4_100);
      expect(startScreencast).toHaveBeenCalledTimes(2);
      expect(capture.getStats().mode).toBe('screencast');

      await vi.advanceTimersByTimeAsync(4_100);
      expect(startScreencast).toHaveBeenCalledTimes(3);
      expect(capture.getStats().mode).toBe('screencast');

      // Stale check 3 exhausts restarts -> switches to polling (>=1500ms interval) and emits frame.
      await vi.advanceTimersByTimeAsync(6_000);

      expect(stopScreencast).toHaveBeenCalled();
      expect(capture.getStats().mode).toBe('poll');
      expect(capture.getStats().running).toBe(true);
      expect(captureScreenshot).toHaveBeenCalled();
      expect(sentFrames.length).toBeGreaterThanOrEqual(2);

      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects pause/resume and prevents overlapping captureScreenshot calls after stall timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveStalled: ((value: { data: string }) => void) | null = null;
      const captureScreenshot = vi.fn().mockImplementation(
        () =>
          new Promise<{ data: string }>((resolve) => {
            resolveStalled = resolve;
          }),
      );
      const client: ScreencastTransportClient = {
        Page: { captureScreenshot },
        close: vi.fn().mockResolvedValue(undefined),
      };

      const capture = new ViewportCapture({ client, fps: 4 });
      capture.start();

      // Pausing suppresses polling ticks until resumed.
      capture.pause();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(captureScreenshot).not.toHaveBeenCalled();

      // Resume -> poll fires at >=1500ms and stalls at 3000ms while underlying promise stays pending.
      capture.resume();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(captureScreenshot).toHaveBeenCalledTimes(1);
      expect(capture.getStats().stalledFrames).toBe(1);

      // Even after multiple poll intervals, no overlapping captureScreenshot fires while pending.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(captureScreenshot).toHaveBeenCalledTimes(1);

      // Settling the hung CDP call allows subsequent polling to proceed cleanly.
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      resolveStalled?.({ data: fakeJpeg.toString('base64') });
      await vi.advanceTimersByTimeAsync(1_600);
      expect(captureScreenshot).toHaveBeenCalledTimes(2);

      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
