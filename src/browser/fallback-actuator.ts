import { ActuatorError } from '../errors/app-error.js';
import type { CanvasRect } from '../game/coordinate-mapper.js';
import type { HudSnapshot } from '../harness/contract-loader.js';
import type {
  BrowserActuator,
  ClickOptions,
  DragOptions,
  KeyHoldOptions,
  KeyPressOptions,
  WheelOptions,
} from './actuator.js';

const DEFAULT_MCP_LATENCY_BUDGET_MS = 150;
const DEFAULT_LATENCY_WINDOW_SIZE = 20;
const DEFAULT_MIN_SAMPLES_FOR_SWITCH = 3;
const DEFAULT_BENCHMARK_POINT = { x: 100, y: 100 } as const;

export interface FallbackActuatorOptions {
  readonly mcp: BrowserActuator;
  readonly cdp: BrowserActuator;
  readonly mcpLatencyBudgetMs?: number;
  readonly latencyWindowSize?: number;
  readonly minSamplesForSwitch?: number;
  readonly now?: () => number;
}

export interface TransportLatencyStats {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly errors: number;
}

export interface LatencyBenchmarkResult {
  readonly samples: number;
  readonly mcp: TransportLatencyStats;
  readonly cdp: TransportLatencyStats;
  readonly recommendedTransport: 'mcp' | 'cdp';
}

export interface FallbackStatus {
  readonly activeClickTransport: 'mcp' | 'cdp';
  readonly switchReason: string | null;
  readonly mcpP50Ms: number;
  readonly mcpP95Ms: number;
  readonly sampleCount: number;
}

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

function summarizeLatencies(
  latencies: readonly number[],
  errors: number,
): TransportLatencyStats {
  if (latencies.length === 0) {
    return {
      p50Ms: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      errors,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sum / sorted.length,
    errors,
  };
}

function isUnsupportedPrimitive(error: unknown): boolean {
  return error instanceof ActuatorError && error.code === 'UNSUPPORTED_PRIMITIVE';
}

/**
 * Coordinates chrome-devtools-mcp (baseline) and direct CDP (fallback).
 * Routes unsupported MCP primitives directly to CDP and auto-switches clicks to CDP
 * if rolling MCP p95 latency exceeds budget or MCP fails.
 */
export class FallbackActuator implements BrowserActuator {
  private readonly mcp: BrowserActuator;
  private readonly cdp: BrowserActuator;
  private readonly mcpLatencyBudgetMs: number;
  private readonly latencyWindowSize: number;
  private readonly minSamplesForSwitch: number;
  private readonly now: () => number;

  private mcpClickLatencies: number[] = [];
  private preferCdpForClicks = false;
  private switchReason: string | null = null;

  constructor(options: FallbackActuatorOptions) {
    this.mcp = options.mcp;
    this.cdp = options.cdp;
    this.mcpLatencyBudgetMs = options.mcpLatencyBudgetMs ?? DEFAULT_MCP_LATENCY_BUDGET_MS;
    this.latencyWindowSize = Math.max(1, options.latencyWindowSize ?? DEFAULT_LATENCY_WINDOW_SIZE);
    this.minSamplesForSwitch = Math.max(
      1,
      options.minSamplesForSwitch ?? DEFAULT_MIN_SAMPLES_FOR_SWITCH,
    );
    this.now = options.now ?? (() => performance.now());
  }

  getStatus(): FallbackStatus {
    const stats = summarizeLatencies(this.mcpClickLatencies, 0);
    return {
      activeClickTransport: this.preferCdpForClicks ? 'cdp' : 'mcp',
      switchReason: this.switchReason,
      mcpP50Ms: stats.p50Ms,
      mcpP95Ms: stats.p95Ms,
      sampleCount: this.mcpClickLatencies.length,
    };
  }

  resetAutoSwitch(): void {
    this.mcpClickLatencies = [];
    this.preferCdpForClicks = false;
    this.switchReason = null;
  }

  async getViewportRect(): Promise<CanvasRect> {
    if (this.preferCdpForClicks) {
      return this.cdp.getViewportRect();
    }
    try {
      return await this.mcp.getViewportRect();
    } catch {
      return this.cdp.getViewportRect();
    }
  }

  async clickAt(x: number, y: number, options?: ClickOptions): Promise<void> {
    const requiresCdp =
      (options?.button !== undefined && options.button !== 'left') ||
      (options?.modifiers !== undefined && options.modifiers.length > 0);

    if (requiresCdp || this.preferCdpForClicks) {
      await this.cdp.clickAt(x, y, options);
      return;
    }

    const startMs = this.now();
    try {
      await this.mcp.clickAt(x, y, options);
      const elapsedMs = Math.max(0, this.now() - startMs);
      this.recordMcpClickLatency(elapsedMs);
    } catch (error) {
      if (!isUnsupportedPrimitive(error)) {
        this.preferCdpForClicks = true;
        this.switchReason =
          error instanceof Error ? `MCP click error: ${error.message}` : 'MCP click error';
      }
      await this.cdp.clickAt(x, y, options);
    }
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options?: DragOptions,
  ): Promise<void> {
    await this.cdp.drag(fromX, fromY, toX, toY, options);
  }

  async wheelAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    options?: WheelOptions,
  ): Promise<void> {
    await this.cdp.wheelAt(x, y, deltaX, deltaY, options);
  }

  async pressKey(key: string, options?: KeyPressOptions): Promise<void> {
    if (options?.holdMs !== undefined && options.holdMs > 0) {
      await this.cdp.pressKey(key, options);
      return;
    }

    try {
      await this.mcp.pressKey(key, options);
    } catch {
      await this.cdp.pressKey(key, options);
    }
  }

  async holdKey(key: string, durationMs: number, options?: KeyHoldOptions): Promise<void> {
    await this.cdp.holdKey(key, durationMs, options);
  }

  async holdKeys(
    keys: readonly string[],
    durationMs: number,
    options?: KeyHoldOptions,
  ): Promise<void> {
    if (this.cdp.holdKeys) {
      await this.cdp.holdKeys(keys, durationMs, options);
      return;
    }
    const perKeyMs = Math.max(1, Math.round(durationMs / Math.max(1, keys.length)));
    for (const key of keys) {
      await this.cdp.holdKey(key, perKeyMs, options);
    }
  }

  async clickDomSelector(selector: string): Promise<void> {
    await this.mcp.clickDomSelector(selector);
  }

  async fillDomSelector(selector: string, value: string): Promise<void> {
    await this.mcp.fillDomSelector(selector, value);
  }

  async readPublicHud(): Promise<HudSnapshot | null> {
    if (this.cdp.readPublicHud) {
      return this.cdp.readPublicHud();
    }
    return null;
  }

  async benchmarkLatency(
    samples = 10,
    target: { readonly x: number; readonly y: number } = DEFAULT_BENCHMARK_POINT,
  ): Promise<LatencyBenchmarkResult> {
    const sampleCount = Math.max(1, Math.floor(samples));
    const mcpStats = await this.measureClicks(this.mcp, sampleCount, target);
    const cdpStats = await this.measureClicks(this.cdp, sampleCount, target);

    const recommendedTransport =
      mcpStats.errors > 0 || mcpStats.p95Ms > this.mcpLatencyBudgetMs ? 'cdp' : 'mcp';

    return {
      samples: sampleCount,
      mcp: mcpStats,
      cdp: cdpStats,
      recommendedTransport,
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.mcp.close(), this.cdp.close()]);
  }

  private recordMcpClickLatency(elapsedMs: number): void {
    const nextWindow = [...this.mcpClickLatencies, elapsedMs];
    this.mcpClickLatencies =
      nextWindow.length > this.latencyWindowSize
        ? nextWindow.slice(nextWindow.length - this.latencyWindowSize)
        : nextWindow;

    if (this.mcpClickLatencies.length >= this.minSamplesForSwitch) {
      const stats = summarizeLatencies(this.mcpClickLatencies, 0);
      if (stats.p95Ms > this.mcpLatencyBudgetMs) {
        this.preferCdpForClicks = true;
        this.switchReason = `MCP p95 latency (${Math.round(stats.p95Ms)}ms) exceeded budget (${this.mcpLatencyBudgetMs}ms)`;
      }
    }
  }

  private async measureClicks(
    actuator: BrowserActuator,
    samples: number,
    target: { readonly x: number; readonly y: number },
  ): Promise<TransportLatencyStats> {
    const latencies: number[] = [];
    let errors = 0;

    for (let i = 0; i < samples; i += 1) {
      const startMs = this.now();
      try {
        await actuator.clickAt(target.x, target.y, { button: 'left' });
        latencies.push(Math.max(0, this.now() - startMs));
      } catch {
        errors += 1;
      }
    }

    return summarizeLatencies(latencies, errors);
  }
}
