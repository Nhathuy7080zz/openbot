import WebSocket from 'ws';
import { ActionExecutor } from '../harness/action-executor.js';
import {
  ActionRequestSchema,
  HudSnapshotSchema,
  PingPongSchema,
  SessionStatusSchema,
  type HudSnapshot,
  type SessionStatus,
} from '../harness/contract-loader.js';
import type { TelemetryLogger, TelemetrySummary } from './telemetry.js';

const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_HUD_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STOP_ON_GAME_OVER_COUNT = 3;
const HUD_GAME_OVER_STOP_COUNT = 2;
const GAME_OVER_RATIONALE_RE =
  /\b(game[\s_-]*over|defeat|victory|you\s+(won|lost)|match\s+(ended|over|concluded)|session\s+(ended|over|concluded|terminated))\b/i;

export function isGameOverRationale(rationale: string): boolean {
  return GAME_OVER_RATIONALE_RE.test(rationale);
}

export interface GameOverEventInfo {
  readonly consecutiveCount: number;
  readonly rationale: string;
}

export interface MatchOrchestratorOptions {
  readonly wsUrl: string;
  readonly executor: ActionExecutor;
  readonly telemetry: TelemetryLogger;
  readonly pingIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly stopOnGameOverCount?: number;
  readonly now?: () => number;
  readonly readHud?: () => Promise<HudSnapshot | null>;
  readonly hudPollIntervalMs?: number;
  readonly onSessionStatus?: (status: SessionStatus) => void;
  readonly onGameOver?: (info: GameOverEventInfo) => void;
}

function extractRationale(args: Readonly<Record<string, unknown>>): string {
  const raw = args['rationale'];
  return typeof raw === 'string' && raw.length > 0 ? raw : '<missing rationale>';
}

/**
 * Connects to the bridge /ws/actions WebSocket, dispatches validated Gemini tool calls
 * to ActionExecutor, streams ActionResponse envelopes back, and records telemetry.
 */
export class MatchOrchestrator {
  private readonly wsUrl: string;
  private readonly executor: ActionExecutor;
  private readonly telemetry: TelemetryLogger;
  private readonly pingIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly stopOnGameOverCount: number;
  private readonly now: () => number;
  private readonly readHud: (() => Promise<HudSnapshot | null>) | undefined;
  private readonly hudPollIntervalMs: number;
  private readonly onSessionStatus: ((status: SessionStatus) => void) | undefined;
  private readonly onGameOver: ((info: GameOverEventInfo) => void) | undefined;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight = Promise.resolve();
  private hudPollBusy = false;
  private consecutiveGameOverWaits = 0;
  private consecutiveHudGameOver = 0;
  private gameOverSignaled = false;

  constructor(options: MatchOrchestratorOptions) {
    this.wsUrl = options.wsUrl;
    this.executor = options.executor;
    this.telemetry = options.telemetry;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.stopOnGameOverCount = options.stopOnGameOverCount ?? DEFAULT_STOP_ON_GAME_OVER_COUNT;
    this.now = options.now ?? (() => Date.now());
    this.readHud = options.readHud;
    this.hudPollIntervalMs = options.hudPollIntervalMs ?? DEFAULT_HUD_POLL_INTERVAL_MS;
    this.onSessionStatus = options.onSessionStatus;
    this.onGameOver = options.onGameOver;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.consecutiveGameOverWaits = 0;
    this.consecutiveHudGameOver = 0;
    this.gameOverSignaled = false;
    await this.connectOnce();
  }

  async stop(): Promise<TelemetrySummary> {
    this.stopped = true;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.hudTimer !== null) {
      clearInterval(this.hudTimer);
      this.hudTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await Promise.race([
      this.inFlight,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (this.ws !== null) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
          setTimeout(resolve, 250);
        });
      }
    }
    return this.telemetry.summarize();
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket(this.wsUrl);
    this.ws = socket;
    let opened = false;

    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
      this.inFlight = this.inFlight.then(() => this.handleMessage(socket, text));
    });

    socket.on('close', () => {
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.hudTimer !== null) {
        clearInterval(this.hudTimer);
        this.hudTimer = null;
      }
      if (opened && !this.stopped) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err) => {
      console.warn('MatchOrchestrator WebSocket error:', err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        opened = true;
        socket.off('error', onError);
        this.startPing(socket);
        this.startHudPoller(socket);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off('open', onOpen);
        reject(err);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
  }

  private startPing(socket: WebSocket): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
    }
    this.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping', timestamp_ms: this.now() }));
      }
    }, this.pingIntervalMs);
  }

  private startHudPoller(socket: WebSocket): void {
    if (this.hudTimer !== null) {
      clearInterval(this.hudTimer);
      this.hudTimer = null;
    }
    if (!this.readHud) {
      return;
    }
    const readHud = this.readHud;
    const pollOnce = async () => {
      if (this.stopped || this.hudPollBusy || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.hudPollBusy = true;
      try {
        const snapshot = await readHud();
        if (snapshot === null) {
          return;
        }
        const validated = HudSnapshotSchema.safeParse(snapshot);
        if (!validated.success) {
          return;
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(validated.data));
        }
        if (validated.data.game_over) {
          this.consecutiveHudGameOver += 1;
          if (
            this.stopOnGameOverCount > 0 &&
            !this.gameOverSignaled &&
            this.consecutiveHudGameOver >= HUD_GAME_OVER_STOP_COUNT
          ) {
            this.gameOverSignaled = true;
            this.onGameOver?.({
              consecutiveCount: this.consecutiveHudGameOver,
              rationale: validated.data.game_over_text ?? 'HUD win-modal Game Over detected',
            });
          }
        } else {
          this.consecutiveHudGameOver = 0;
        }
      } catch {
        // Non-fatal: transient DOM read errors skip this tick cleanly.
      } finally {
        this.hudPollBusy = false;
      }
    };

    void pollOnce();
    this.hudTimer = setInterval(() => {
      void pollOnce();
    }, this.hudPollIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce().catch((err: unknown) => {
        console.warn('MatchOrchestrator reconnect failed:', err instanceof Error ? err.message : String(err));
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  private async handleMessage(socket: WebSocket, rawText: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return;
    }

    const reqResult = ActionRequestSchema.safeParse(parsed);
    if (reqResult.success) {
      const req = reqResult.data;
      const response = await this.executor.execute(req);
      const completedAtMs = this.now();
      const rationale = extractRationale(req.arguments);

      this.telemetry.logAction({
        callId: req.call_id,
        sessionId: req.session_id,
        toolName: req.tool_name,
        rationale,
        status: response.status,
        frameCapturedAtMs: req.frame_captured_at_ms,
        modelEmittedAtMs: req.model_emitted_at_ms,
        actionCompletedAtMs: completedAtMs,
        scheduling: response.scheduling,
        artifacts: response.artifacts,
        ...(response.status === 'error' || response.status === 'failed'
          ? { errorSummary: response.summary }
          : {}),
      });

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(response));
      }

      if (req.tool_name === 'wait_observe' && isGameOverRationale(rationale)) {
        this.consecutiveGameOverWaits += 1;
        if (
          this.stopOnGameOverCount > 0 &&
          !this.gameOverSignaled &&
          this.consecutiveGameOverWaits >= this.stopOnGameOverCount
        ) {
          this.gameOverSignaled = true;
          this.onGameOver?.({
            consecutiveCount: this.consecutiveGameOverWaits,
            rationale,
          });
        }
      } else {
        this.consecutiveGameOverWaits = 0;
      }
      return;
    }

    const statusResult = SessionStatusSchema.safeParse(parsed);
    if (statusResult.success) {
      this.telemetry.logSessionStatus(statusResult.data);
      this.onSessionStatus?.(statusResult.data);
      return;
    }

    const pingResult = PingPongSchema.safeParse(parsed);
    if (pingResult.success && pingResult.data.type === 'ping' && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'pong', timestamp_ms: pingResult.data.timestamp_ms }));
    }
  }
}
