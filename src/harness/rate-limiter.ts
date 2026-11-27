import { RateLimitExceededError } from '../errors/app-error.js';

const DEFAULT_MAX_APM = 45;
const DEFAULT_BURST_CAP = 3;
const DEFAULT_MIN_JITTER_MS = 40;
const DEFAULT_MAX_JITTER_MS = 120;
const MS_PER_MINUTE = 60_000;
const GAUSSIAN_STDDEV_DIVISOR = 6;
const MIN_RNG_EPSILON = 1e-12;

export interface RateLimiterOptions {
  readonly maxApm?: number;
  readonly burstCap?: number;
  readonly minJitterMs?: number;
  readonly maxJitterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rng?: () => number;
}

export interface RateLimitConsumeResult {
  readonly remainingTokens: number;
  readonly jitterMs: number;
}

export interface RateLimitAcquireResult {
  readonly waitedMs: number;
  readonly jitterMs: number;
  readonly remainingTokens: number;
}

export interface RateLimiterState {
  readonly tokens: number;
  readonly capacity: number;
  readonly maxApm: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Token-bucket rate limiter enforcing sustained APM, burst cap, and bounded Gaussian jitter.
 */
export class RateLimiter {
  private readonly maxApm: number;
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly minJitterMs: number;
  private readonly maxJitterMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly rng: () => number;

  private tokens: number;
  private lastRefillMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxApm = options.maxApm ?? DEFAULT_MAX_APM;
    this.capacity = options.burstCap ?? DEFAULT_BURST_CAP;
    this.minJitterMs = options.minJitterMs ?? DEFAULT_MIN_JITTER_MS;
    this.maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? defaultSleep;
    this.rng = options.rng ?? (() => Math.random());

    if (this.maxApm <= 0 || this.capacity <= 0) {
      throw new RangeError('maxApm and burstCap must be positive numbers');
    }
    if (this.minJitterMs < 0 || this.maxJitterMs < this.minJitterMs) {
      throw new RangeError('Invalid jitter bounds');
    }

    this.refillRatePerMs = this.maxApm / MS_PER_MINUTE;
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  getState(): RateLimiterState {
    this.refill();
    return {
      tokens: this.tokens,
      capacity: this.capacity,
      maxApm: this.maxApm,
    };
  }

  tryConsume(): RateLimitConsumeResult {
    this.refill();

    if (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      const retryAfterMs = Math.max(1, Math.ceil(deficit / this.refillRatePerMs));
      throw new RateLimitExceededError(retryAfterMs);
    }

    this.tokens -= 1;
    return {
      remainingTokens: this.tokens,
      jitterMs: this.sampleGaussianJitterMs(),
    };
  }

  async acquire(): Promise<RateLimitAcquireResult> {
    let waitedMs = 0;

    while (true) {
      try {
        const { jitterMs, remainingTokens } = this.tryConsume();
        if (jitterMs > 0) {
          await this.sleepFn(jitterMs);
        }
        return {
          waitedMs,
          jitterMs,
          remainingTokens,
        };
      } catch (error) {
        if (!(error instanceof RateLimitExceededError)) {
          throw error;
        }
        const waitMs = Math.max(1, error.retryAfterMs);
        await this.sleepFn(waitMs);
        waitedMs += waitMs;
      }
    }
  }

  private refill(): void {
    const currentNow = this.now();
    const elapsedMs = Math.max(0, currentNow - this.lastRefillMs);
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillRatePerMs);
      this.lastRefillMs = currentNow;
    }
  }

  private sampleGaussianJitterMs(): number {
    if (this.minJitterMs === this.maxJitterMs) {
      return this.minJitterMs;
    }

    const u1 = Math.max(MIN_RNG_EPSILON, Math.min(1, this.rng()));
    const u2 = Math.max(0, Math.min(1, this.rng()));
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const mean = (this.minJitterMs + this.maxJitterMs) / 2;
    const stddev = (this.maxJitterMs - this.minJitterMs) / GAUSSIAN_STDDEV_DIVISOR;
    return clampInt(mean + z0 * stddev, this.minJitterMs, this.maxJitterMs);
  }
}
