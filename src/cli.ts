import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP from 'chrome-remote-interface';
import type { BrowserActuator } from './browser/actuator.js';
import { CdpActuator } from './browser/cdp-actuator.js';
import { launchNonThrottledBrowser, type LaunchedBrowser } from './browser/chrome-launcher.js';
import { FallbackActuator } from './browser/fallback-actuator.js';
import { CdpLobbyPageAdapter, LobbyNavigator } from './browser/lobby-navigator.js';
import { McpActuator } from './browser/mcp-actuator.js';
import { ViewportCapture } from './browser/viewport-capture.js';
import { loadConfig, redactConfig } from './config/env.js';
import { ConfigValidationError } from './errors/app-error.js';
import { ActionExecutor } from './harness/action-executor.js';
import { RateLimiter } from './harness/rate-limiter.js';
import { MatchOrchestrator } from './loop/orchestrator.js';
import { TelemetryLogger } from './loop/telemetry.js';

const DEFAULT_MATCH_DURATION_S = 600;
const CAPTURE_FPS = 2.5;

export interface CliRuntimeOptions {
  readonly durationSeconds: number;
  readonly launchBrowser: boolean;
  readonly headless: boolean;
  readonly useMcp: boolean;
  readonly stopOnGameOver: boolean;
}

function parseOptionValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ConfigValidationError(`Missing value for CLI flag ${flag}`);
      }
      return next;
    }
    if (arg !== undefined && arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

export function parseCliRuntimeOptions(
  argv: readonly string[],
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): CliRuntimeOptions {
  const durationRaw =
    parseOptionValue(argv, '--duration') ?? rawEnv['OPENBOT_MATCH_DURATION_S'];
  const durationSeconds =
    durationRaw !== undefined ? Number(durationRaw) : DEFAULT_MATCH_DURATION_S;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ConfigValidationError(
      `Invalid --duration value "${durationRaw ?? ''}"; expected positive number of seconds`,
    );
  }

  return {
    durationSeconds,
    launchBrowser: !argv.includes('--no-launch-browser'),
    headless: argv.includes('--headless'),
    useMcp: argv.includes('--use-mcp'),
    stopOnGameOver: !argv.includes('--no-stop-on-game-over'),
  };
}

export function parseHostPort(rawUrl: string): { host: string; port: number } {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port.length > 0 ? Number(parsed.port) : 9222;
  return { host, port };
}

async function ensureCaptureClientTab(options: {
  readonly cdpUrl: string;
  readonly gameUrlPrefix: string;
  readonly captureClientUrl: string;
}): Promise<void> {
  const { host, port } = parseHostPort(options.cdpUrl);
  const targets = await CDP.List({ host, port });
  const gameTarget =
    targets.find((t) => t.type === 'page' && t.url.startsWith(options.gameUrlPrefix)) ??
    targets.find((t) => t.type === 'page' && !t.url.includes('/capture-client'));

  const existingCapture = targets.find(
    (t) => t.type === 'page' && t.url.includes('/capture-client'),
  );
  if (!existingCapture) {
    await CDP.New({ host, port, url: options.captureClientUrl });
  }

  // Keep the OpenFront game tab active so Chromium GPU compositor commits fresh frames.
  if (gameTarget) {
    await CDP.Activate({ host, port, id: gameTarget.id });
  }
}

async function fetchBridgeHealth(bridgeBaseUrl: string): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${bridgeBaseUrl}/health`);
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function waitForDurationOrSignal(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onSignal = () => {
      finish();
    };
    const onAbort = () => {
      finish();
    };
    const timer = setTimeout(finish, durationMs);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig(process.env, argv);
  const runtime = parseCliRuntimeOptions(argv, process.env);
  const { host: cdpHost, port: cdpPort } = parseHostPort(config.cdpUrl);
  const bridgeHttpUrl = `http://${config.bridgeHost}:${config.bridgePort}`;
  const bridgeWsUrl = `ws://${config.bridgeHost}:${config.bridgePort}`;

  process.stdout.write(
    `${JSON.stringify({ event: 'openbot_config', config: redactConfig(config), runtime })}\n`,
  );

  let browser: LaunchedBrowser | null = null;
  let captureHandle: { capture: ViewportCapture; close: () => Promise<void> } | null = null;
  let cdpActuator: CdpActuator | null = null;
  let mcpActuator: McpActuator | null = null;
  let orchestrator: MatchOrchestrator | null = null;

  try {
    if (runtime.launchBrowser) {
      browser = await launchNonThrottledBrowser({
        cdpPort,
        initialUrl: config.lobbyUrl ?? config.targetUrl,
        headless: runtime.headless,
      });
    }

    const activeCdpUrl = browser?.cdpUrl ?? `http://${cdpHost}:${cdpPort}`;
    const gameUrlPrefix = new URL(config.lobbyUrl ?? config.targetUrl).origin;

    const lobbyAdapter = await CdpLobbyPageAdapter.connect({
      cdpUrl: activeCdpUrl,
      targetUrlPrefix: gameUrlPrefix,
    });
    try {
      const lobbyNavigator = new LobbyNavigator({ adapter: lobbyAdapter });
      const joinResult = await lobbyNavigator.joinLobby({
        targetUrl: config.targetUrl,
        ...(config.lobbyUrl !== undefined ? { lobbyUrl: config.lobbyUrl } : {}),
      });
      process.stdout.write(`${JSON.stringify({ event: 'lobby_joined', ...joinResult })}\n`);
    } finally {
      await lobbyAdapter.close();
    }

    const initialBridgeHealth = await fetchBridgeHealth(bridgeHttpUrl);
    if (initialBridgeHealth?.['brain_mode'] !== 'dual') {
      await ensureCaptureClientTab({
        cdpUrl: activeCdpUrl,
        gameUrlPrefix,
        captureClientUrl: `${bridgeHttpUrl}/capture-client?session_id=openbot-match`,
      });
    }

    captureHandle = await ViewportCapture.connectAndStream({
      cdpUrl: activeCdpUrl,
      targetUrlPrefix: gameUrlPrefix,
      bridgeCaptureWsUrl: `${bridgeWsUrl}/ws/capture-frames`,
      fps: CAPTURE_FPS,
    });

    cdpActuator = await CdpActuator.connect({
      cdpUrl: activeCdpUrl,
      targetUrlPrefix: gameUrlPrefix,
    });

    let activeActuator: BrowserActuator = cdpActuator;
    if (runtime.useMcp) {
      mcpActuator = await McpActuator.connect({
        args: ['-y', 'chrome-devtools-mcp@latest', `--browser-url=${activeCdpUrl}`, '--experimentalVision=true'],
      });
      activeActuator = new FallbackActuator({
        mcp: mcpActuator,
        cdp: cdpActuator,
      });
    }

    const executor = new ActionExecutor({
      actuator: activeActuator,
      rateLimiter: new RateLimiter({
        maxApm: config.maxApm,
        burstCap: 5,
        minJitterMs: 10,
        maxJitterMs: 25,
      }),
      beforeExecute: () => {
        captureHandle?.capture.pause();
      },
      afterExecute: () => {
        captureHandle?.capture.resume();
      },
    });

    const telemetry = new TelemetryLogger({
      logFilePath: path.resolve('logs', `match-${Date.now()}.jsonl`),
    });

    const stopController = new AbortController();

    orchestrator = new MatchOrchestrator({
      wsUrl: `${bridgeWsUrl}/ws/actions`,
      executor,
      telemetry,
      stopOnGameOverCount: runtime.stopOnGameOver ? 3 : 0,
      readHud: () => activeActuator.readPublicHud?.() ?? Promise.resolve(null),
      onGameOver: (info) => {
        process.stdout.write(
          `${JSON.stringify({ event: 'early_stop_on_game_over', ...info })}\n`,
        );
        stopController.abort();
      },
      onSessionStatus: (status) => {
        process.stdout.write(`${JSON.stringify({ event: 'session_status', status })}\n`);
        if (status.state === 'error') {
          process.stdout.write(
            `${JSON.stringify({ event: 'early_stop_on_session_error', status })}\n`,
          );
          stopController.abort();
        }
      },
    });

    await orchestrator.start();
    process.stdout.write(
      `${JSON.stringify({
        event: 'match_loop_started',
        durationSeconds: runtime.durationSeconds,
        logFilePath: telemetry.logFilePath,
      })}\n`,
    );

    await waitForDurationOrSignal(runtime.durationSeconds * 1000, stopController.signal);

    const summary = await orchestrator.stop();
    orchestrator = null;
    const bridgeHealth = await fetchBridgeHealth(bridgeHttpUrl);

    process.stdout.write(
      `${JSON.stringify({
        event: 'match_summary',
        captureStats: captureHandle.capture.getStats(),
        telemetry: summary,
        bridgeHealth,
      })}\n`,
    );
  } finally {
    if (orchestrator !== null) {
      await orchestrator.stop().catch(() => undefined);
    }
    if (captureHandle !== null) {
      await captureHandle.close().catch(() => undefined);
    }
    if (mcpActuator !== null) {
      await mcpActuator.close().catch(() => undefined);
    }
    if (cdpActuator !== null) {
      await cdpActuator.close().catch(() => undefined);
    }
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
  }
}

const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainEntry) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`OpenBot CLI failed: ${message}\n`);
    process.exitCode = 1;
  });
}
