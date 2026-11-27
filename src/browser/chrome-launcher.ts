import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActuatorError } from '../errors/app-error.js';

const DEFAULT_DEBUG_PORT = 9222;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 250;

const CANDIDATE_BROWSER_PATHS: readonly string[] = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export interface BrowserLaunchOptions {
  readonly executablePath?: string;
  readonly cdpPort?: number;
  readonly width?: number;
  readonly height?: number;
  readonly initialUrl?: string;
  readonly headless?: boolean;
}

export interface LaunchedBrowser {
  readonly pid: number;
  readonly cdpUrl: string;
  readonly executablePath: string;
  readonly userDataDir: string;
  close(): Promise<void>;
}

export function resolveBrowserExecutable(explicitPath?: string): string {
  const envPath = process.env['CHROME_PATH']?.trim();
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    ...(envPath ? [envPath] : []),
    ...CANDIDATE_BROWSER_PATHS,
  ];

  for (const candidate of candidates) {
    if (candidate.length > 0 && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new ActuatorError(
    'No Chromium/Chrome/Edge executable found; set CHROME_PATH env variable.',
    'CONNECTION_ERROR',
  );
}

async function waitForCdpReady(cdpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `${cdpUrl.replace(/\/$/, '')}/json/version`;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(endpoint);
      if (resp.ok) {
        return;
      }
    } catch {
      // Browser still starting
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new ActuatorError(`Browser CDP did not become ready at ${endpoint} within ${timeoutMs}ms`, 'CONNECTION_ERROR');
}

function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    proc.kill('SIGTERM');
  } catch {
    // Ignore already exited process
  }
}

/**
 * Launches Chrome/Edge with remote debugging and background-throttling disabled
 * so Pixi.js/WebGL requestAnimationFrame keeps rendering at steady cadence.
 */
export async function launchNonThrottledBrowser(
  options: BrowserLaunchOptions = {},
): Promise<LaunchedBrowser> {
  const executablePath = resolveBrowserExecutable(options.executablePath);
  const cdpPort = options.cdpPort ?? DEFAULT_DEBUG_PORT;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-chrome-'));
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  const args: string[] = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--window-position=40,40',
    '--lang=en-US',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    '--disable-ipc-flooding-protection',
    '--autoplay-policy=no-user-gesture-required',
    ...(options.headless ? ['--headless=new'] : []),
    options.initialUrl ?? 'about:blank',
  ];

  const proc = spawn(executablePath, args, {
    stdio: 'ignore',
    detached: false,
  });

  if (proc.pid === undefined) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new ActuatorError(`Failed to spawn browser process: ${executablePath}`, 'CONNECTION_ERROR');
  }

  try {
    await waitForCdpReady(cdpUrl, READY_TIMEOUT_MS);
  } catch (error) {
    killProcessTree(proc);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Ignore locked profile cleanup race on Windows
    }
    throw error;
  }

  return {
    pid: proc.pid,
    cdpUrl,
    executablePath,
    userDataDir,
    close: () => {
      killProcessTree(proc);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Ignore locked profile cleanup race on Windows
      }
      return Promise.resolve();
    },
  };
}
