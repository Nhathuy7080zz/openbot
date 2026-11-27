import CDP from 'chrome-remote-interface';
import WebSocket from 'ws';
import { ActuatorError } from '../errors/app-error.js';

const DEFAULT_FPS = 1.0;
const DEFAULT_JPEG_QUALITY = 70;
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 3000;
const DEFAULT_SCREENCAST_MAX_WIDTH = 960;
const DEFAULT_SCREENCAST_MAX_HEIGHT = 540;
const DEFAULT_SCREENCAST_EVERY_NTH_FRAME = 10;
const MIN_POLL_INTERVAL_MS = 1_500;
const MAX_SCREENCAST_RESTARTS = 2;

export interface ScreencastFrameEvent {
  readonly data: string;
  readonly sessionId: number;
}

export interface ScreencastTransportClient {
  readonly Page: {
    captureScreenshot(params: {
      format: 'jpeg' | 'png';
      quality?: number;
      fromSurface?: boolean;
      optimizeForSpeed?: boolean;
    }): Promise<{ data: string }>;
    startScreencast?(params: {
      format: 'jpeg' | 'png';
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      everyNthFrame?: number;
    }): Promise<void>;
    stopScreencast?(): Promise<void>;
    screencastFrameAck?(params: { sessionId: number }): Promise<void>;
    bringToFront?(): Promise<void>;
  };
  close(): Promise<void>;
}

export interface ViewportCaptureOptions {
  readonly client: ScreencastTransportClient;
  readonly fps?: number;
  readonly jpegQuality?: number;
  readonly now?: () => number;
  readonly onFrame?: (jpegBuffer: Buffer) => void | Promise<void>;
}

export interface ViewportCaptureConnectOptions {
  readonly cdpUrl: string;
  readonly targetUrlPrefix?: string;
  readonly bridgeCaptureWsUrl: string;
  readonly fps?: number;
  readonly jpegQuality?: number;
}

export interface ViewportCaptureStats {
  readonly capturedFrames: number;
  readonly failedFrames: number;
  readonly stalledFrames: number;
  readonly running: boolean;
  readonly mode: 'screencast' | 'poll';
}

/**
 * Captures the full GPU-composited OpenFront viewport (WebGL map + Lit HTML HUD overlays)
 * via async CDP Page.startScreencast (with Page.captureScreenshot fallback) and streams
 * throttled JPEG frames to the local Pipecat bridge without stalling CDP input dispatch.
 */
export class ViewportCapture {
  private readonly client: ScreencastTransportClient;
  private readonly intervalMs: number;
  private readonly jpegQuality: number;
  private readonly now: () => number;
  private readonly onFrame: ((jpegBuffer: Buffer) => void | Promise<void>) | undefined;

  private timer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private running = false;
  private capturedFrames = 0;
  private failedFrames = 0;
  private stalledFrames = 0;
  private lastScreencastSentMs = 0;
  private lastFrameAtMs = 0;
  private mode: 'screencast' | 'poll' = 'poll';
  private paused = false;
  private screencastRestarts = 0;
  private activeScreenshotPromise: Promise<unknown> | null = null;

  constructor(options: ViewportCaptureOptions) {
    this.client = options.client;
    const fps = Math.max(0.2, Math.min(10, options.fps ?? DEFAULT_FPS));
    this.intervalMs = Math.round(1000 / fps);
    this.jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
    this.now = options.now ?? (() => Date.now());
    this.onFrame = options.onFrame;
  }

  static async connectAndStream(
    options: ViewportCaptureConnectOptions,
  ): Promise<{ capture: ViewportCapture; close: () => Promise<void> }> {
    const parsedCdp = new URL(options.cdpUrl);
    const host = parsedCdp.hostname || '127.0.0.1';
    const port = parsedCdp.port.length > 0 ? Number(parsedCdp.port) : 9222;

    const targets = await CDP.List({ host, port });
    const pageTarget =
      targets.find(
        (t) =>
          t.type === 'page' &&
          (options.targetUrlPrefix ? t.url.startsWith(options.targetUrlPrefix) : !t.url.includes('/capture-client')),
      ) ?? targets.find((t) => t.type === 'page');

    if (!pageTarget) {
      throw new ActuatorError('No page target found on CDP for ViewportCapture', 'CONNECTION_ERROR');
    }

    const rawClient = await CDP({ host, port, target: pageTarget.id });
    const restrictedClient: ScreencastTransportClient = {
      Page: {
        captureScreenshot: (params) => rawClient.Page.captureScreenshot(params),
        startScreencast: (params) => rawClient.Page.startScreencast(params),
        stopScreencast: () => rawClient.Page.stopScreencast(),
        screencastFrameAck: (params) => rawClient.Page.screencastFrameAck(params),
        bringToFront: () => rawClient.Page.bringToFront(),
      },
      close: async () => {
        await rawClient.close();
      },
    };

    const ws = new WebSocket(options.bridgeCaptureWsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        ws.off('open', onOpen);
        reject(new ActuatorError(`Capture WS failed: ${err.message}`, 'CONNECTION_ERROR'));
      };
      ws.once('open', onOpen);
      ws.once('error', onErr);
    });

    const capture = new ViewportCapture({
      client: restrictedClient,
      ...(options.fps !== undefined ? { fps: options.fps } : {}),
      ...(options.jpegQuality !== undefined ? { jpegQuality: options.jpegQuality } : {}),
      onFrame: (buf) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      },
    });

    await restrictedClient.Page.bringToFront?.().catch(() => undefined);
    const rawEventTarget = rawClient as unknown as {
      on?: (event: string, listener: (payload: ScreencastFrameEvent) => void) => void;
    };
    rawEventTarget.on?.('Page.screencastFrame', (ev) => {
      void capture.handleScreencastFrame(ev);
    });

    await capture.startScreencastOrFallback();

    return {
      capture,
      close: async () => {
        await capture.stop();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };
  }

  getStats(): ViewportCaptureStats {
    return {
      capturedFrames: this.capturedFrames,
      failedFrames: this.failedFrames,
      stalledFrames: this.stalledFrames,
      running: this.running,
      mode: this.mode,
    };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async handleScreencastFrame(event: ScreencastFrameEvent): Promise<boolean> {
    // Ack immediately so Chromium never stalls the screencast compositor pipeline.
    if (this.client.Page.screencastFrameAck) {
      await this.client.Page.screencastFrameAck({ sessionId: event.sessionId }).catch(() => undefined);
    }

    const nowMs = this.now();
    if (event.data && event.data.length > 0) {
      this.lastFrameAtMs = nowMs;
    }
    if (this.lastScreencastSentMs > 0 && nowMs - this.lastScreencastSentMs < this.intervalMs) {
      return false;
    }

    if (!event.data || event.data.length === 0) {
      this.failedFrames += 1;
      return false;
    }

    const buffer = Buffer.from(event.data, 'base64');
    if (buffer.length === 0) {
      this.failedFrames += 1;
      return false;
    }

    this.lastScreencastSentMs = nowMs;
    this.capturedFrames += 1;
    this.screencastRestarts = 0;
    if (this.onFrame) {
      await this.onFrame(buffer);
    }
    return true;
  }

  private fallbackToPoll(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.client.Page.stopScreencast) {
      void this.client.Page.stopScreencast().catch(() => undefined);
    }
    // start() exits early while this.running is true; clear before switching to poll mode.
    this.running = false;
    this.start();
  }

  startScreencastWatchdog(
    staleThresholdMs = 4_000,
    checkIntervalMs = 1_000,
    maxRestarts = MAX_SCREENCAST_RESTARTS,
  ): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogTimer = setInterval(() => {
      if (!this.running || this.mode !== 'screencast') {
        return;
      }
      if (this.now() - this.lastFrameAtMs < staleThresholdMs) {
        return;
      }
      if (this.screencastRestarts < maxRestarts && this.client.Page.startScreencast) {
        this.screencastRestarts += 1;
        this.lastFrameAtMs = this.now();
        void (async () => {
          await this.client.Page.stopScreencast?.().catch(() => undefined);
          await this.client.Page.bringToFront?.().catch(() => undefined);
          if (!this.running || this.mode !== 'screencast') {
            return;
          }
          try {
            await this.client.Page.startScreencast?.({
              format: 'jpeg',
              quality: this.jpegQuality,
              maxWidth: DEFAULT_SCREENCAST_MAX_WIDTH,
              maxHeight: DEFAULT_SCREENCAST_MAX_HEIGHT,
              everyNthFrame: DEFAULT_SCREENCAST_EVERY_NTH_FRAME,
            });
          } catch {
            if (this.running && this.mode === 'screencast') {
              this.fallbackToPoll();
            }
          }
        })();
        return;
      }
      this.fallbackToPoll();
    }, checkIntervalMs);
  }

  async startScreencastOrFallback(): Promise<'screencast' | 'poll'> {
    if (this.client.Page.startScreencast) {
      try {
        await this.client.Page.startScreencast({
          format: 'jpeg',
          quality: this.jpegQuality,
          maxWidth: DEFAULT_SCREENCAST_MAX_WIDTH,
          maxHeight: DEFAULT_SCREENCAST_MAX_HEIGHT,
          everyNthFrame: DEFAULT_SCREENCAST_EVERY_NTH_FRAME,
        });
        this.mode = 'screencast';
        this.running = true;
        this.lastFrameAtMs = this.now();
        this.startScreencastWatchdog();
        return 'screencast';
      } catch {
        // Fall back cleanly to screenshot polling if screencast is unsupported.
      }
    }
    this.start();
    return 'poll';
  }

  async captureOnce(): Promise<Buffer> {
    let result: { data: string };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.stalledFrames += 1;
          reject(
            new ActuatorError(
              `CDP Page.captureScreenshot timed out after ${DEFAULT_SCREENSHOT_TIMEOUT_MS}ms`,
              'CDP_ERROR',
            ),
          );
        }, DEFAULT_SCREENSHOT_TIMEOUT_MS);
      });
      const rawPromise = this.client.Page.captureScreenshot({
        format: 'jpeg',
        quality: this.jpegQuality,
        fromSurface: true,
        optimizeForSpeed: true,
      });
      this.activeScreenshotPromise = rawPromise;
      void rawPromise.catch(() => undefined).finally(() => {
        if (this.activeScreenshotPromise === rawPromise) {
          this.activeScreenshotPromise = null;
        }
      });
      result = await Promise.race([rawPromise, timeoutPromise]);
    } catch (error) {
      this.failedFrames += 1;
      if (error instanceof ActuatorError) {
        throw error;
      }
      throw new ActuatorError('CDP Page.captureScreenshot failed', 'CDP_ERROR', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (!result.data || result.data.length === 0) {
      this.failedFrames += 1;
      throw new ActuatorError('Empty screenshot payload returned from CDP Page.captureScreenshot', 'CDP_ERROR');
    }

    const buffer = Buffer.from(result.data, 'base64');
    if (buffer.length === 0) {
      this.failedFrames += 1;
      throw new ActuatorError('Decoded screenshot buffer is empty', 'CDP_ERROR');
    }

    this.capturedFrames += 1;
    if (this.onFrame) {
      await this.onFrame(buffer);
    }
    return buffer;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.mode = 'poll';
    this.running = true;
    const pollIntervalMs = Math.max(this.intervalMs, MIN_POLL_INTERVAL_MS);
    this.timer = setInterval(() => {
      if (this.inFlight || this.activeScreenshotPromise !== null || this.paused || !this.running) {
        return;
      }
      this.inFlight = true;
      void this.captureOnce()
        .catch(() => {
          // failedFrames/stalledFrames already accounted inside captureOnce()
        })
        .finally(() => {
          this.inFlight = false;
        });
    }, pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.mode === 'screencast' && this.client.Page.stopScreencast) {
      await this.client.Page.stopScreencast().catch(() => undefined);
    }
    await this.client.close();
  }
}
