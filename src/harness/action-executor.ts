import type { BrowserActuator } from '../browser/actuator.js';
import {
  AppError,
  RateLimitExceededError,
  ToolValidationError,
  ViewportError,
} from '../errors/app-error.js';
import { CoordinateMapper, type PixelPoint } from '../game/coordinate-mapper.js';
import {
  OPENFRONT_ATTACK_RATIO_BOUNDS,
  OPENFRONT_DIPLOMACY_ACTIONS,
  OPENFRONT_KEYBINDS,
  OPENFRONT_STRUCTURES,
  type BuildableKey,
} from '../game/interaction-map.js';
import type { ActionResponse, RecoveryContract } from './contract-loader.js';
import type { RateLimiter } from './rate-limiter.js';
import {
  createToolObservation,
  parseActionRequest,
  type ParsedActionRequest,
} from './tool-parser.js';

const DEFAULT_PAN_HOLD_MS = 300;
const DEFAULT_ALT_VIEW_HOLD_MS = 300;
const WHEEL_PIXELS_PER_ZOOM_STEP = 120;
const ZOOM_MAP_STEP_DELTA_Y = 150;
const ZOOM_STEP_SETTLE_MS = 25;
const DEFAULT_BUILD_VERIFY_DELAY_MS = 280;
const BUILD_SELECT_SETTLE_MS = 30;
const DEFAULT_OVERVIEW_ZOOM_OUT_STEPS = 8;
const DEFAULT_PLAN_STEP_DELAY_MS = 80;
const EXPAND_BURST_DELAY_MS = 85;
const DEFAULT_EXPAND_BURST_SPREAD = 0.06;

const PAN_KEY_MAP = {
  up: OPENFRONT_KEYBINDS.moveUp,
  down: OPENFRONT_KEYBINDS.moveDown,
  left: OPENFRONT_KEYBINDS.moveLeft,
  right: OPENFRONT_KEYBINDS.moveRight,
} as const;

const PAN_MULTI_KEY_MAP = {
  up: [OPENFRONT_KEYBINDS.moveUp],
  down: [OPENFRONT_KEYBINDS.moveDown],
  left: [OPENFRONT_KEYBINDS.moveLeft],
  right: [OPENFRONT_KEYBINDS.moveRight],
  up_left: [OPENFRONT_KEYBINDS.moveUp, OPENFRONT_KEYBINDS.moveLeft],
  up_right: [OPENFRONT_KEYBINDS.moveUp, OPENFRONT_KEYBINDS.moveRight],
  down_left: [OPENFRONT_KEYBINDS.moveDown, OPENFRONT_KEYBINDS.moveLeft],
  down_right: [OPENFRONT_KEYBINDS.moveDown, OPENFRONT_KEYBINDS.moveRight],
} as const;

export interface ActionExecutorOptions {
  readonly actuator: BrowserActuator;
  readonly rateLimiter: RateLimiter;
  readonly coordinateMapper?: CoordinateMapper;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly blockingRateLimit?: boolean;
  readonly initialAttackRatioPct?: number;
  readonly buildVerifyDelayMs?: number;
  readonly beforeExecute?: () => void;
  readonly afterExecute?: () => void;
}

interface RatioTransition {
  readonly keyPresses: readonly string[];
  readonly appliedRatioPct: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stepRatioUp(current: number): number {
  const { minPercent, maxPercent, incrementPercent } = OPENFRONT_ATTACK_RATIO_BOUNDS;
  if (current <= minPercent) {
    return incrementPercent;
  }
  return Math.min(maxPercent, current + incrementPercent);
}

function stepRatioDown(current: number): number {
  const { minPercent, incrementPercent } = OPENFRONT_ATTACK_RATIO_BOUNDS;
  return Math.max(minPercent, current - incrementPercent);
}

function computeRatioTransition(currentPct: number, targetPct: number): RatioTransition {
  const { minPercent, maxPercent } = OPENFRONT_ATTACK_RATIO_BOUNDS;
  const clampedTarget = Math.min(maxPercent, Math.max(minPercent, Math.round(targetPct)));

  if (clampedTarget === currentPct) {
    return { keyPresses: [], appliedRatioPct: currentPct };
  }

  const keyPresses: string[] = [];
  let cursor = currentPct;

  if (clampedTarget > currentPct) {
    while (cursor < clampedTarget) {
      const next = stepRatioUp(cursor);
      if (Math.abs(next - clampedTarget) >= Math.abs(cursor - clampedTarget)) {
        break;
      }
      keyPresses.push(OPENFRONT_KEYBINDS.attackRatioUp);
      cursor = next;
    }
  } else {
    while (cursor > clampedTarget) {
      const next = stepRatioDown(cursor);
      if (Math.abs(next - clampedTarget) >= Math.abs(cursor - clampedTarget)) {
        break;
      }
      keyPresses.push(OPENFRONT_KEYBINDS.attackRatioDown);
      cursor = next;
    }
  }

  return { keyPresses, appliedRatioPct: cursor };
}

function extractCallId(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'call_id' in raw) {
    const candidate = (raw as { call_id?: unknown }).call_id;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return 'unknown';
}

function buildRecoveryForError(error: unknown): RecoveryContract {
  if (error instanceof ToolValidationError) {
    return {
      root_cause: `ToolValidationError: ${error.message}`,
      safe_retry: 'Fix tool_name or argument bounds to match [0..1] coordinates and contract enums',
      stop_condition: 'Stop retrying after 2 consecutive schema rejections',
    };
  }
  if (error instanceof RateLimitExceededError) {
    return {
      root_cause: `Rate limit exceeded (retry after ${error.retryAfterMs}ms)`,
      safe_retry: `Call wait_observe for at least ${Math.max(500, error.retryAfterMs)}ms before next action`,
      stop_condition: 'Do not burst above maxApm; pause and observe',
    };
  }
  if (error instanceof ViewportError) {
    return {
      root_cause: `ViewportError: ${error.message}`,
      safe_retry: 'Ensure #game-input-overlay is visible and retry with [0..1] coordinates',
      stop_condition: 'Stop after 2 consecutive viewport failures and wait_observe',
    };
  }
  if (error instanceof AppError) {
    return {
      root_cause: `${error.name} (${error.code}): ${error.message}`,
      safe_retry: 'Verify browser session health and retry once',
      stop_condition: 'Abort action loop if browser connection remains broken',
    };
  }
  return {
    root_cause: error instanceof Error ? error.message : String(error),
    safe_retry: 'Call wait_observe to inspect latest frame before retrying',
    stop_condition: 'Stop after 2 consecutive unexpected execution failures',
  };
}

/**
 * Executes validated Gemini tool calls through RateLimiter -> CoordinateMapper -> BrowserActuator
 * and returns deterministic ActionResponse observations.
 */
export class ActionExecutor {
  private readonly actuator: BrowserActuator;
  private readonly rateLimiter: RateLimiter;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly blockingRateLimit: boolean;
  private readonly buildVerifyDelayMs: number;
  private readonly beforeExecute: (() => void) | undefined;
  private readonly afterExecute: (() => void) | undefined;

  private coordinateMapper: CoordinateMapper | undefined;
  private currentAttackRatioPct: number;
  private cameraZoomed = false;
  private consecutiveZoomedTurns = 0;

  constructor(options: ActionExecutorOptions) {
    this.actuator = options.actuator;
    this.rateLimiter = options.rateLimiter;
    this.coordinateMapper = options.coordinateMapper;
    this.now = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? defaultSleep;
    this.blockingRateLimit = options.blockingRateLimit ?? true;
    this.buildVerifyDelayMs = Math.max(
      0,
      options.buildVerifyDelayMs ?? DEFAULT_BUILD_VERIFY_DELAY_MS,
    );
    this.beforeExecute = options.beforeExecute;
    this.afterExecute = options.afterExecute;
    this.currentAttackRatioPct =
      options.initialAttackRatioPct ?? OPENFRONT_ATTACK_RATIO_BOUNDS.defaultPercent;
  }

  getCurrentAttackRatioPct(): number {
    return this.currentAttackRatioPct;
  }

  isCameraZoomed(): boolean {
    return this.cameraZoomed;
  }

  getConsecutiveZoomedTurns(): number {
    return this.consecutiveZoomedTurns;
  }

  async execute(rawRequest: unknown): Promise<ActionResponse> {
    const startMs = this.now();
    const fallbackCallId = extractCallId(rawRequest);

    try {
      const parsed = parseActionRequest(rawRequest);
      return await this.executeParsed(parsed, startMs);
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startMs);
      const message = error instanceof Error ? error.message : String(error);
      return createToolObservation({
        callId: fallbackCallId,
        status: 'error',
        summary: message,
        nextActions: ['wait_observe'],
        artifacts: {},
        latencyMs,
        scheduling: 'INTERRUPT',
        recovery: buildRecoveryForError(error),
      });
    }
  }

  async executeParsed(
    request: ParsedActionRequest,
    startedAtMs: number = this.now(),
  ): Promise<ActionResponse> {
    try {
      if (this.blockingRateLimit) {
        await this.rateLimiter.acquire();
      } else {
        this.rateLimiter.tryConsume();
      }

      this.beforeExecute?.();
      try {
        return await this.dispatchTool(request, startedAtMs);
      } finally {
        this.afterExecute?.();
      }
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startedAtMs);
      const message = error instanceof Error ? error.message : String(error);
      return createToolObservation({
        callId: request.call_id,
        status: 'error',
        summary: message,
        nextActions: ['wait_observe'],
        artifacts: { tool: request.tool_name },
        latencyMs,
        scheduling: 'INTERRUPT',
        recovery: buildRecoveryForError(error),
      });
    }
  }

  private async dispatchTool(
    request: ParsedActionRequest,
    startedAtMs: number,
  ): Promise<ActionResponse> {
    switch (request.tool_name) {
      case 'select_spawn': {
        const pixel = await this.mapNormalizedPoint(request.arguments.x, request.arguments.y);
        await this.actuator.clickAt(pixel.px, pixel.py, { button: 'left' });
        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Selected spawn at (${pixel.px}, ${pixel.py})`,
          nextActions: ['wait_observe', 'attack_territory'],
          artifacts: {
            pixel,
            normalized: { x: request.arguments.x, y: request.arguments.y },
          },
          latencyMs: this.now() - startedAtMs,
        });
      }

      case 'attack_territory': {
        let ratioTransition: RatioTransition | undefined;
        if (request.arguments.ratio_pct !== undefined) {
          ratioTransition = await this.applyAttackRatio(request.arguments.ratio_pct);
        }

        const mode = request.arguments.mode ?? 'ground';
        const pixel = await this.mapNormalizedPoint(request.arguments.x, request.arguments.y);
        if (mode === 'boat') {
          await this.actuator.pressKey(OPENFRONT_KEYBINDS.boatAttack);
        }
        await this.actuator.clickAt(pixel.px, pixel.py, { button: 'left' });

        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Launched ${mode} attack at (${pixel.px}, ${pixel.py})`,
          nextActions: ['wait_observe', 'build_structure'],
          artifacts: {
            mode,
            pixel,
            appliedRatioPct: ratioTransition?.appliedRatioPct ?? this.currentAttackRatioPct,
          },
          latencyMs: this.now() - startedAtMs,
        });
      }

      case 'set_attack_ratio': {
        const transition = await this.applyAttackRatio(request.arguments.ratio_pct);
        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Set attack ratio to ${transition.appliedRatioPct}% (${transition.keyPresses.length} step(s))`,
          nextActions: ['attack_territory'],
          artifacts: {
            requestedRatioPct: request.arguments.ratio_pct,
            appliedRatioPct: transition.appliedRatioPct,
            keyPresses: transition.keyPresses,
          },
          latencyMs: this.now() - startedAtMs,
        });
      }

      case 'build_structure': {
        return this.executeBuildOrLaunch({
          callId: request.call_id,
          key: request.arguments.structure,
          kind: 'structure',
          x: request.arguments.x,
          y: request.arguments.y,
          startedAtMs,
        });
      }

      case 'launch_special': {
        return this.executeBuildOrLaunch({
          callId: request.call_id,
          key: request.arguments.unit,
          kind: 'unit',
          x: request.arguments.x,
          y: request.arguments.y,
          startedAtMs,
        });
      }

      case 'diplomacy_action': {
        const descriptor = OPENFRONT_DIPLOMACY_ACTIONS[request.arguments.action];
        const pixel = await this.mapNormalizedPoint(request.arguments.x, request.arguments.y);

        if (descriptor.hotkey !== null) {
          await this.actuator.pressKey(descriptor.hotkey);
          await this.actuator.clickAt(pixel.px, pixel.py, { button: 'left' });
        } else {
          await this.actuator.clickAt(pixel.px, pixel.py, { button: 'right' });
        }

        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary:
            descriptor.hotkey !== null
              ? `Executed ${descriptor.key} at (${pixel.px}, ${pixel.py})`
              : `Opened radial menu for ${descriptor.key} at (${pixel.px}, ${pixel.py})`,
          nextActions: ['wait_observe'],
          artifacts: {
            action: descriptor.key,
            hotkey: descriptor.hotkey,
            pixel,
          },
          latencyMs: this.now() - startedAtMs,
        });
      }

      case 'camera_control': {
        const executedOps: string[] = [];
        const args = request.arguments;

        if (args.center_camera === true) {
          await this.actuator.pressKey(OPENFRONT_KEYBINDS.centerCamera);
          executedOps.push('center_camera');
        }
        if (args.toggle_coord_grid === true) {
          await this.actuator.pressKey(OPENFRONT_KEYBINDS.coordinateGrid);
          executedOps.push('toggle_coord_grid');
        }
        if (args.toggle_alt_view === true) {
          await this.actuator.holdKey(OPENFRONT_KEYBINDS.toggleView, DEFAULT_ALT_VIEW_HOLD_MS);
          executedOps.push('toggle_alt_view');
        }
        if (args.pan !== undefined) {
          const panKey = PAN_KEY_MAP[args.pan];
          const panMs = args.pan_ms ?? DEFAULT_PAN_HOLD_MS;
          await this.actuator.holdKey(panKey, panMs);
          executedOps.push(`pan:${args.pan}:${panMs}ms`);
        }
        if (args.zoom_steps !== undefined && args.zoom_steps !== 0) {
          const centerPixel = await this.mapNormalizedPoint(0.5, 0.5);
          const deltaY = -args.zoom_steps * WHEEL_PIXELS_PER_ZOOM_STEP;
          await this.actuator.wheelAt(centerPixel.px, centerPixel.py, 0, deltaY);
          executedOps.push(`zoom:${args.zoom_steps}`);
        }

        const isNoop = executedOps.length === 0;
        return createToolObservation({
          callId: request.call_id,
          status: isNoop ? 'warning' : 'success',
          summary: isNoop
            ? 'No camera control operation specified'
            : `Executed camera controls: ${executedOps.join(', ')}`,
          nextActions: ['wait_observe'],
          artifacts: { executedOps },
          latencyMs: this.now() - startedAtMs,
          scheduling: isNoop ? 'WHEN_IDLE' : 'SILENT',
        });
      }

      case 'zoom_map': {
        const anchorX = request.arguments.x ?? 0.5;
        const anchorY = request.arguments.y ?? 0.5;
        const anchor = await this.mapNormalizedPoint(anchorX, anchorY);
        const stepDeltaY =
          request.arguments.direction === 'in'
            ? -ZOOM_MAP_STEP_DELTA_Y
            : ZOOM_MAP_STEP_DELTA_Y;

        for (let step = 0; step < request.arguments.steps; step += 1) {
          await this.actuator.wheelAt(anchor.px, anchor.py, 0, stepDeltaY);
          if (step + 1 < request.arguments.steps) {
            await this.sleepFn(ZOOM_STEP_SETTLE_MS);
          }
        }
        if (request.arguments.direction === 'in') {
          this.cameraZoomed = true;
        } else {
          this.cameraZoomed = false;
          this.consecutiveZoomedTurns = 0;
        }

        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Zoomed ${request.arguments.direction} ${request.arguments.steps} step(s) at (${anchor.px}, ${anchor.py})`,
          nextActions: ['attack_territory', 'build_structure', 'pan_map', 'wait_observe'],
          artifacts: {
            direction: request.arguments.direction,
            steps: request.arguments.steps,
            anchor,
            normalized: { x: anchorX, y: anchorY },
          },
          latencyMs: this.now() - startedAtMs,
          scheduling: 'SILENT',
        });
      }

      case 'pan_map': {
        const args = request.arguments;
        if (args.center_camera === true) {
          await this.actuator.pressKey(OPENFRONT_KEYBINDS.centerCamera);
        }
        const keys = PAN_MULTI_KEY_MAP[args.direction];
        if (this.actuator.holdKeys) {
          await this.actuator.holdKeys(keys, args.duration_ms);
        } else {
          const singleKey = keys[0];
          if (keys.length === 1 && singleKey !== undefined) {
            await this.actuator.holdKey(singleKey, args.duration_ms);
          } else {
            const perKeyMs = Math.max(1, Math.round(args.duration_ms / keys.length));
            for (const key of keys) {
              await this.actuator.holdKey(key, perKeyMs);
            }
          }
        }

        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Panned ${args.direction} for ${args.duration_ms}ms`,
          nextActions: ['attack_territory', 'build_structure', 'zoom_map', 'wait_observe'],
          artifacts: {
            direction: args.direction,
            durationMs: args.duration_ms,
            keys: [...keys],
            centerCamera: args.center_camera === true,
          },
          latencyMs: this.now() - startedAtMs,
          scheduling: 'SILENT',
        });
      }

      case 'wait_observe': {
        await this.sleepFn(request.arguments.duration_ms);
        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Observed game state for ${request.arguments.duration_ms}ms`,
          nextActions: ['attack_territory', 'build_structure', 'wait_observe'],
          artifacts: { durationMs: request.arguments.duration_ms },
          latencyMs: this.now() - startedAtMs,
          scheduling: 'WHEN_IDLE',
        });
      }

      case 'focus_region': {
        const anchor = await this.mapNormalizedPoint(request.arguments.x, request.arguments.y);
        const totalDeltaY = -request.arguments.zoom_steps * ZOOM_MAP_STEP_DELTA_Y;
        await this.actuator.wheelAt(anchor.px, anchor.py, 0, totalDeltaY);
        this.cameraZoomed = true;
        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Focused region (${anchor.px}, ${anchor.py}) zoom +${request.arguments.zoom_steps}`,
          nextActions: ['attack_territory', 'build_structure', 'reset_overview'],
          artifacts: {
            zoomSteps: request.arguments.zoom_steps,
            totalDeltaY,
            anchor,
            normalized: { x: request.arguments.x, y: request.arguments.y },
          },
          latencyMs: this.now() - startedAtMs,
          scheduling: 'SILENT',
        });
      }

      case 'reset_overview': {
        const zoomOutSteps = request.arguments.zoom_out_steps ?? DEFAULT_OVERVIEW_ZOOM_OUT_STEPS;
        await this.actuator.pressKey(OPENFRONT_KEYBINDS.centerCamera);
        await this.sleepFn(20);
        const center = await this.mapNormalizedPoint(0.5, 0.5);
        const totalDeltaY = zoomOutSteps * ZOOM_MAP_STEP_DELTA_Y;
        await this.actuator.wheelAt(center.px, center.py, 0, totalDeltaY);
        this.cameraZoomed = false;
        this.consecutiveZoomedTurns = 0;
        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Reset camera overview (KeyC + zoom out ${zoomOutSteps} steps)`,
          nextActions: ['attack_territory', 'focus_region', 'build_structure'],
          artifacts: { zoomOutSteps, totalDeltaY, center },
          latencyMs: this.now() - startedAtMs,
          scheduling: 'SILENT',
        });
      }

      case 'expand_burst': {
        const args = request.arguments;
        let ratioTransition: RatioTransition | undefined;
        if (args.ratio_pct !== undefined) {
          ratioTransition = await this.applyAttackRatio(args.ratio_pct);
        }
        const spread = args.spread ?? DEFAULT_EXPAND_BURST_SPREAD;
        const count = args.count ?? 4;
        const rawOffsets: ReadonlyArray<readonly [number, number]> = [
          [spread, 0],
          [-spread, 0],
          [0, -spread],
          [0, spread],
        ];
        const stepResults: Array<{
          readonly index: number;
          readonly toolName: string;
          readonly status: ActionResponse['status'];
          readonly summary: string;
          readonly artifacts: Readonly<Record<string, unknown>>;
        }> = [];
        const clampCoord = (v: number): number => Math.min(0.98, Math.max(0.02, v));

        for (let i = 0; i < count; i += 1) {
          const [dx, dy] = rawOffsets[i]!;
          const nx = clampCoord(args.x + dx);
          const ny = clampCoord(args.y + dy);
          const pixel = await this.mapNormalizedPoint(nx, ny);
          await this.actuator.clickAt(pixel.px, pixel.py, { button: 'left' });
          stepResults.push({
            index: i,
            toolName: 'attack_territory',
            status: 'success',
            summary: `Burst attack at (${pixel.px}, ${pixel.py})`,
            artifacts: {
              mode: 'ground',
              pixel,
              normalized: { x: nx, y: ny },
              appliedRatioPct: ratioTransition?.appliedRatioPct ?? this.currentAttackRatioPct,
              burst: true,
            },
          });
          if (i + 1 < count) {
            await this.sleepFn(EXPAND_BURST_DELAY_MS);
          }
        }

        return createToolObservation({
          callId: request.call_id,
          status: 'success',
          summary: `Executed expand_burst (${count} strikes around ${args.x.toFixed(2)},${args.y.toFixed(2)})`,
          nextActions: ['attack_territory', 'build_structure', 'expand_burst'],
          artifacts: {
            totalSteps: count,
            executedSteps: count,
            burstSpread: spread,
            appliedRatioPct: ratioTransition?.appliedRatioPct ?? this.currentAttackRatioPct,
            stepResults,
          },
          latencyMs: this.now() - startedAtMs,
        });
      }

      case 'execute_plan': {
        const parsedSteps = request.arguments.actions.map((step, index) =>
          parseActionRequest({
            type: 'action_request',
            call_id: `${request.call_id}-step-${index}`,
            session_id: request.session_id,
            tool_name: step.tool_name,
            arguments: step.arguments,
            frame_captured_at_ms: request.frame_captured_at_ms,
            model_emitted_at_ms: request.model_emitted_at_ms,
          }),
        );

        const stepDelayMs = request.arguments.step_delay_ms ?? DEFAULT_PLAN_STEP_DELAY_MS;
        const stepResults: Array<{
          readonly index: number;
          readonly toolName: string;
          readonly status: ActionResponse['status'];
          readonly summary: string;
          readonly artifacts: Readonly<Record<string, unknown>>;
        }> = [];

        let aborted = false;
        let hasWarning = false;
        let failedSteps = 0;
        let abortError = false;
        let abortRecovery: RecoveryContract | undefined;

        for (let index = 0; index < parsedSteps.length; index += 1) {
          const subReq = parsedSteps[index]!;
          let subResponse: ActionResponse;
          try {
            subResponse = await this.dispatchTool(subReq, this.now());
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            subResponse = createToolObservation({
              callId: subReq.call_id,
              status: 'error',
              summary: errMsg,
              nextActions: ['wait_observe'],
              artifacts: { tool: subReq.tool_name },
              latencyMs: 0,
              scheduling: 'INTERRUPT',
              recovery: buildRecoveryForError(error),
            });
          }

          stepResults.push({
            index,
            toolName: subReq.tool_name,
            status: subResponse.status,
            summary: subResponse.summary,
            artifacts: subResponse.artifacts,
          });

          if (subResponse.status === 'error') {
            aborted = true;
            abortError = true;
            abortRecovery = subResponse.recovery;
            break;
          }
          if (subResponse.status === 'failed') {
            failedSteps += 1;
          } else if (subResponse.status === 'warning') {
            hasWarning = true;
          }
          if (index + 1 < parsedSteps.length) {
            await this.sleepFn(stepDelayMs);
          }
        }

        if (!aborted) {
          const endedWithReset =
            stepResults[stepResults.length - 1]?.toolName === 'reset_overview';
          const focusIndex = stepResults.findIndex(
            (s) => s.toolName === 'focus_region' && s.status === 'success',
          );
          const buildAfterFocus =
            focusIndex >= 0 &&
            stepResults.some(
              (s, i) =>
                i > focusIndex &&
                (s.toolName === 'build_structure' || s.toolName === 'launch_special'),
            );
          const hadFocusAndSuccessBuild =
            focusIndex >= 0 &&
            stepResults.some(
              (s) =>
                (s.toolName === 'build_structure' || s.toolName === 'launch_special') &&
                s.status === 'success',
            );
          const hadFocusAndBuild = buildAfterFocus || hadFocusAndSuccessBuild;
          const shouldAutoReset =
            this.cameraZoomed &&
            !endedWithReset &&
            (hadFocusAndBuild || this.consecutiveZoomedTurns + 1 >= 2);

          if (shouldAutoReset) {
            await this.sleepFn(stepDelayMs);
            const resetReq = parseActionRequest({
              type: 'action_request',
              call_id: `${request.call_id}-auto-reset`,
              session_id: request.session_id,
              tool_name: 'reset_overview',
              arguments: { zoom_out_steps: 6, rationale: 'Auto camera hygiene reset' },
              frame_captured_at_ms: request.frame_captured_at_ms,
              model_emitted_at_ms: request.model_emitted_at_ms,
            });
            try {
              const resetRes = await this.dispatchTool(resetReq, this.now());
              stepResults.push({
                index: stepResults.length,
                toolName: 'reset_overview',
                status: resetRes.status,
                summary: resetRes.summary,
                artifacts: { ...resetRes.artifacts, autoReset: true },
              });
            } catch {
              // Non-fatal: keep batch result intact if auto-reset encounters transient error.
            }
          } else if (this.cameraZoomed) {
            this.consecutiveZoomedTurns += 1;
          } else {
            this.consecutiveZoomedTurns = 0;
          }
        }

        const finalStatus: ActionResponse['status'] = abortError
          ? 'error'
          : failedSteps > 0 && failedSteps === stepResults.length
            ? 'failed'
            : failedSteps > 0 || hasWarning
              ? 'warning'
              : 'success';

        const stepSummaryText = stepResults
          .map((s) => `${s.toolName}:${s.status}`)
          .join(', ');
        return createToolObservation({
          callId: request.call_id,
          status: finalStatus,
          summary: aborted
            ? `Plan aborted at step ${stepResults.length}/${parsedSteps.length} (${stepSummaryText})`
            : `Executed ${stepResults.length}/${stepResults.length} plan step(s): ${stepSummaryText}`,
          nextActions: ['attack_territory', 'build_structure', 'wait_observe'],
          artifacts: {
            totalSteps: stepResults.length,
            executedSteps: stepResults.length,
            aborted,
            stepDelayMs,
            cameraZoomed: this.cameraZoomed,
            stepResults,
          },
          latencyMs: this.now() - startedAtMs,
          ...(abortRecovery !== undefined ? { recovery: abortRecovery } : {}),
        });
      }
    }
  }

  private async executeBuildOrLaunch(params: {
    readonly callId: string;
    readonly key: BuildableKey;
    readonly kind: 'structure' | 'unit';
    readonly x: number;
    readonly y: number;
    readonly startedAtMs: number;
  }): Promise<ActionResponse> {
    const descriptor = OPENFRONT_STRUCTURES[params.key];
    const pixel = await this.mapNormalizedPoint(params.x, params.y);

    // Pre-click HUD gold guard: avoid wasting 400ms + Escape when obviously unaffordable.
    const preHud = this.actuator.readPublicHud ? await this.actuator.readPublicHud() : null;
    const preGold = preHud?.gold ?? null;
    if (preGold !== null && preGold < descriptor.baseGoldCost) {
      return createToolObservation({
        callId: params.callId,
        status: 'failed',
        summary: `Build ${descriptor.unitType} skipped: insufficient_gold (have ${preGold}, need >= ${descriptor.baseGoldCost})`,
        nextActions: ['attack_territory', 'focus_region', 'wait_observe'],
        artifacts: {
          [params.kind]: descriptor.key,
          unitType: descriptor.unitType,
          hotkey: descriptor.hotkey,
          pixel,
          verified: false,
          reason: 'insufficient_gold',
          preGold,
          requiredGold: descriptor.baseGoldCost,
          skippedBeforeClick: true,
        },
        latencyMs: this.now() - params.startedAtMs,
        scheduling: 'WHEN_IDLE',
      });
    }

    // Clear any stale ghost placement before selecting the structure hotkey.
    await this.actuator.pressKey(OPENFRONT_KEYBINDS.cancelOrClose);
    await this.actuator.pressKey(descriptor.hotkey);
    if (BUILD_SELECT_SETTLE_MS > 0) {
      await this.sleepFn(BUILD_SELECT_SETTLE_MS);
    }
    await this.actuator.clickAt(pixel.px, pixel.py, { button: 'left' });
    if (this.buildVerifyDelayMs > 0) {
      await this.sleepFn(this.buildVerifyDelayMs);
    }
    // Always exit placement mode so persistent ghosts never hijack subsequent attacks.
    await this.actuator.pressKey(OPENFRONT_KEYBINDS.cancelOrClose);

    const postHud =
      preGold !== null && this.actuator.readPublicHud ? await this.actuator.readPublicHud() : null;
    const postGold = postHud?.gold ?? null;
    const goldDelta = preGold !== null && postGold !== null ? postGold - preGold : null;
    const verified =
      preGold !== null && postGold !== null ? postGold < preGold : null;

    const baseArtifacts: Record<string, unknown> = {
      [params.kind]: descriptor.key,
      unitType: descriptor.unitType,
      hotkey: descriptor.hotkey,
      pixel,
      verified,
      preGold,
      postGold,
      goldDelta,
    };

    if (verified === false) {
      return createToolObservation({
        callId: params.callId,
        status: 'failed',
        summary: `Build ${descriptor.unitType} failed: insufficient_gold_or_invalid_tile at (${pixel.px}, ${pixel.py})`,
        nextActions: ['attack_territory', 'focus_region', 'wait_observe'],
        artifacts: {
          ...baseArtifacts,
          reason: 'insufficient_gold_or_invalid_tile',
        },
        latencyMs: this.now() - params.startedAtMs,
        scheduling: 'WHEN_IDLE',
      });
    }

    const verb = params.kind === 'structure' ? 'Built' : 'Launched';
    return createToolObservation({
      callId: params.callId,
      status: 'success',
      summary:
        verified === true
          ? `${verb} ${descriptor.unitType} at (${pixel.px}, ${pixel.py}) (gold ${goldDelta})`
          : `${verb} ${descriptor.unitType} at (${pixel.px}, ${pixel.py})`,
      nextActions: params.kind === 'structure' ? ['wait_observe', 'build_structure'] : ['wait_observe'],
      artifacts: baseArtifacts,
      latencyMs: this.now() - params.startedAtMs,
    });
  }

  private async applyAttackRatio(targetPct: number): Promise<RatioTransition> {
    const transition = computeRatioTransition(this.currentAttackRatioPct, targetPct);
    for (const key of transition.keyPresses) {
      await this.actuator.pressKey(key);
    }
    this.currentAttackRatioPct = transition.appliedRatioPct;
    return transition;
  }

  private async mapNormalizedPoint(x: number, y: number): Promise<PixelPoint> {
    if (this.coordinateMapper === undefined) {
      const rect = await this.actuator.getViewportRect();
      this.coordinateMapper = new CoordinateMapper(rect, { now: this.now });
    } else if (this.coordinateMapper.isStale()) {
      const rect = await this.actuator.getViewportRect();
      this.coordinateMapper.updateRect(rect);
    }
    return this.coordinateMapper.toPixel(x, y);
  }
}
