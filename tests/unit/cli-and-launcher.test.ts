import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpLobbyPageAdapter, type CdpLobbyClientLike } from '../../src/browser/lobby-navigator.js';
import { resolveBrowserExecutable } from '../../src/browser/chrome-launcher.js';
import { parseCliRuntimeOptions, parseHostPort, waitForDurationOrSignal } from '../../src/cli.js';
import { ActuatorError, ConfigValidationError } from '../../src/errors/app-error.js';

import { isGameOverRationale } from '../../src/loop/orchestrator.js';

describe('parseCliRuntimeOptions', () => {
  it('uses defaults when no flags or env overrides are provided', () => {
    const parsed = parseCliRuntimeOptions([], {});
    expect(parsed).toEqual({
      durationSeconds: 600,
      launchBrowser: true,
      headless: false,
      useMcp: false,
      stopOnGameOver: true,
    });
  });

  it('parses CLI flags and env overrides cleanly', () => {
    const parsed = parseCliRuntimeOptions(
      ['--duration=90', '--no-launch-browser', '--headless', '--use-mcp', '--no-stop-on-game-over'],
      { OPENBOT_MATCH_DURATION_S: '120' },
    );
    expect(parsed).toEqual({
      durationSeconds: 90,
      launchBrowser: false,
      headless: true,
      useMcp: true,
      stopOnGameOver: false,
    });

    const spaceDuration = parseCliRuntimeOptions(['--duration', '45'], {});
    expect(spaceDuration.durationSeconds).toBe(45);
  });

  it('rejects missing or non-positive --duration values', () => {
    expect(() => parseCliRuntimeOptions(['--duration'], {})).toThrow(ConfigValidationError);
    expect(() => parseCliRuntimeOptions(['--duration', '0'], {})).toThrow(ConfigValidationError);
    expect(() => parseCliRuntimeOptions(['--duration', 'abc'], {})).toThrow(ConfigValidationError);
  });
});

describe('resolveBrowserExecutable', () => {
  const originalChromePath = process.env['CHROME_PATH'];

  afterEach(() => {
    if (originalChromePath === undefined) {
      delete process.env['CHROME_PATH'];
    } else {
      process.env['CHROME_PATH'] = originalChromePath;
    }
  });

  it('prefers explicit executablePath and CHROME_PATH env when files exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-bin-'));
    const fakeExe = path.join(tmpDir, 'fake-browser.exe');
    fs.writeFileSync(fakeExe, 'stub');

    expect(resolveBrowserExecutable(fakeExe)).toBe(fakeExe);

    process.env['CHROME_PATH'] = fakeExe;
    expect(resolveBrowserExecutable()).toBe(fakeExe);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws ActuatorError when explicit and CHROME_PATH paths do not exist and system has no candidate', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      expect(() => resolveBrowserExecutable('/nonexistent/chrome')).toThrow(ActuatorError);
    } finally {
      existsSpy.mockRestore();
    }
  });
});

describe('CdpLobbyPageAdapter', () => {
  it('delegates navigate, evaluateBool, clickFirstMatching, and close to CDP client', async () => {
    const navigateMock = vi.fn().mockResolvedValue({});
    const evaluateMock = vi.fn().mockResolvedValue({ result: { value: true } });
    const closeMock = vi.fn().mockResolvedValue(undefined);

    const client: CdpLobbyClientLike = {
      Page: { navigate: navigateMock },
      Runtime: { evaluate: evaluateMock },
      close: closeMock,
    };

    const adapter = new CdpLobbyPageAdapter(client);
    await adapter.navigate('http://localhost:9000');
    expect(navigateMock).toHaveBeenCalledWith({ url: 'http://localhost:9000' });

    const ready = await adapter.evaluateBool('Boolean(true)');
    expect(ready).toBe(true);

    const clicked = await adapter.clickFirstMatching(['button'], ['solo']);
    expect(clicked).toBe(true);
    expect(evaluateMock).toHaveBeenCalledTimes(2);

    await adapter.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe('CLI host and early-stop signal helpers', () => {
  it('parses host and explicit/default ports from CDP URL', () => {
    expect(parseHostPort('http://127.0.0.1:19222')).toEqual({ host: '127.0.0.1', port: 19222 });
    expect(parseHostPort('http://localhost')).toEqual({ host: 'localhost', port: 9222 });
  });

  it('resolves waitForDurationOrSignal immediately when aborted via AbortController', async () => {
    const controller = new AbortController();
    const promise = waitForDurationOrSignal(60_000, controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(waitForDurationOrSignal(60_000, preAborted.signal)).resolves.toBeUndefined();
  });

  it('detects Game Over wait_observe rationales cleanly without false positives on active expansion', () => {
    expect(isGameOverRationale('GAME_OVER: Defeat screen displayed')).toBe(true);
    expect(isGameOverRationale('Still on game over screen, waiting for conclusion.')).toBe(true);
    expect(isGameOverRationale('You won the match, waiting.')).toBe(true);
    expect(isGameOverRationale('Recovering troops (<15%) before resuming expansion.')).toBe(false);
  });
});
