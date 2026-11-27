import { describe, expect, it, vi } from 'vitest';
import { LobbyNavigator, type LobbyPageAdapter } from '../../src/browser/lobby-navigator.js';
import { ActuatorError } from '../../src/errors/app-error.js';

describe('LobbyNavigator', () => {
  it('joins a direct --lobby-url and waits for #game-input-overlay', async () => {
    let overlayReady = false;
    const navigateSpy = vi.fn().mockImplementation(() => {
      overlayReady = true;
      return Promise.resolve();
    });
    const evaluateBoolSpy = vi.fn().mockImplementation(() => Promise.resolve(overlayReady));
    const clickSpy = vi.fn().mockResolvedValue(true);

    const adapter: LobbyPageAdapter = {
      navigate: navigateSpy,
      evaluateBool: evaluateBoolSpy,
      clickFirstMatching: clickSpy,
    };

    const navigator = new LobbyNavigator({
      adapter,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await navigator.joinLobby({
      targetUrl: 'http://localhost:9000',
      lobbyUrl: 'http://localhost:9000/join/abc123',
    });

    expect(result.mode).toBe('direct_lobby_url');
    expect(result.navigatedUrl).toBe('http://localhost:9000/join/abc123');
    expect(navigateSpy).toHaveBeenCalledWith('http://localhost:9000/join/abc123');
  });

  it('auto-joins local Solo match when no lobbyUrl is supplied', async () => {
    let clickCount = 0;
    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.fn().mockImplementation(() => {
      clickCount += 1;
      return Promise.resolve(true);
    });
    const evaluateBoolSpy = vi.fn().mockImplementation(() => Promise.resolve(clickCount >= 2));

    const adapter: LobbyPageAdapter = {
      navigate: navigateSpy,
      clickFirstMatching: clickSpy,
      evaluateBool: evaluateBoolSpy,
    };

    const navigator = new LobbyNavigator({
      adapter,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await navigator.joinLobby({
      targetUrl: 'http://localhost:9000',
    });

    expect(result.mode).toBe('local_solo_auto');
    expect(navigateSpy).toHaveBeenCalledWith('http://localhost:9000');
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('throws ActuatorError when #game-input-overlay does not mount within timeout', async () => {
    const adapter: LobbyPageAdapter = {
      navigate: vi.fn().mockResolvedValue(undefined),
      clickFirstMatching: vi.fn().mockResolvedValue(false),
      evaluateBool: vi.fn().mockResolvedValue(false),
    };

    const navigator = new LobbyNavigator({
      adapter,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      timeoutMs: 5,
    });

    await expect(
      navigator.joinLobby({
        targetUrl: 'http://localhost:9000',
        lobbyUrl: 'http://localhost:9000/join/missing',
      }),
    ).rejects.toThrow(ActuatorError);
  });

  it('throws ActuatorError if local Solo button cannot be clicked before timeout', async () => {
    let fakeNow = 0;
    const adapter: LobbyPageAdapter = {
      navigate: vi.fn().mockResolvedValue(undefined),
      clickFirstMatching: vi.fn().mockResolvedValue(false),
      evaluateBool: vi.fn().mockResolvedValue(false),
    };

    const navigator = new LobbyNavigator({
      adapter,
      sleep: () => {
        fakeNow += 5;
        return Promise.resolve();
      },
      now: () => fakeNow,
      pollIntervalMs: 5,
      timeoutMs: 10,
    });

    await expect(
      navigator.joinLobby({
        targetUrl: 'http://localhost:9000',
      }),
    ).rejects.toThrow(ActuatorError);
  });
});
