import { describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../../src/errors/app-error.js';
import { RateLimiter } from '../../src/harness/rate-limiter.js';

describe('RateLimiter', () => {
  it('enforces burst cap via tryConsume and reports accurate retryAfterMs', () => {
    let nowMs = 10_000;
    const limiter = new RateLimiter({
      maxApm: 45,
      burstCap: 3,
      now: () => nowMs,
      rng: () => 0.5,
    });

    expect(limiter.tryConsume().remainingTokens).toBe(2);
    expect(limiter.tryConsume().remainingTokens).toBe(1);
    expect(limiter.tryConsume().remainingTokens).toBe(0);

    let thrown: unknown;
    try {
      limiter.tryConsume();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RateLimitExceededError);
    const rateErr = thrown as RateLimitExceededError;
    // 45 APM = 0.75 tokens/sec => 1 token every ~1333.33ms => ceil = 1334ms
    expect(rateErr.retryAfterMs).toBe(1334);
    expect(rateErr.code).toBe('RATE_LIMIT_EXCEEDED');

    // Advance clock by 1334ms -> 1 token refilled
    nowMs += 1334;
    expect(() => limiter.tryConsume()).not.toThrow();
  });

  it('bounds Gaussian human jitter within [40..120] ms using injectable PRNG', () => {
    const nowMs = 0;
    const rngValues = [0.0001, 0.0, 0.9999, 0.5, 0.25, 0.75];
    let rngIdx = 0;
    const limiter = new RateLimiter({
      maxApm: 60,
      burstCap: 10,
      now: () => nowMs,
      rng: () => {
        const val = rngValues[rngIdx % rngValues.length] ?? 0.5;
        rngIdx += 1;
        return val;
      },
    });

    for (let i = 0; i < 10; i += 1) {
      const result = limiter.tryConsume();
      expect(result.jitterMs).toBeGreaterThanOrEqual(40);
      expect(result.jitterMs).toBeLessThanOrEqual(120);
      expect(Number.isInteger(result.jitterMs)).toBe(true);
    }
  });

  it('acquire waits when bucket is empty and applies jitter sleep', async () => {
    let nowMs = 5_000;
    const sleepCalls: number[] = [];
    const limiter = new RateLimiter({
      maxApm: 60, // 1 token per 1000ms
      burstCap: 1,
      now: () => nowMs,
      sleep: (ms: number) => {
        sleepCalls.push(ms);
        nowMs += ms;
        return Promise.resolve();
      },
      rng: () => 0.5,
    });

    const first = await limiter.acquire();
    expect(first.waitedMs).toBe(0);
    expect(first.jitterMs).toBeGreaterThanOrEqual(40);
    expect(first.jitterMs).toBeLessThanOrEqual(120);

    // Exhaust next immediate token by resetting clock back slightly? Actually first jitter advanced nowMs by ~64ms (< 1000ms)
    const second = await limiter.acquire();
    expect(second.waitedMs).toBeGreaterThan(0);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes state, handles fixed jitter bounds, and rejects invalid configuration', () => {
    const fixedLimiter = new RateLimiter({
      maxApm: 30,
      burstCap: 2,
      minJitterMs: 50,
      maxJitterMs: 50,
      now: () => 0,
    });

    expect(fixedLimiter.getState()).toEqual({ tokens: 2, capacity: 2, maxApm: 30 });
    expect(fixedLimiter.tryConsume().jitterMs).toBe(50);
    expect(fixedLimiter.getState().tokens).toBe(1);

    expect(() => new RateLimiter({ maxApm: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ burstCap: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ minJitterMs: 100, maxJitterMs: 50 })).toThrow(RangeError);
  });
});
