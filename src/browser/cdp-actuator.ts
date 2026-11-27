import CDP from 'chrome-remote-interface';
import { z } from 'zod';
import { ActuatorError, ViewportError } from '../errors/app-error.js';
import type { CanvasRect } from '../game/coordinate-mapper.js';
import type { HudSnapshot } from '../harness/contract-loader.js';
import type {
  BrowserActuator,
  ClickOptions,
  DragOptions,
  KeyHoldOptions,
  KeyModifier,
  KeyPressOptions,
  MouseButton,
  WheelOptions,
} from './actuator.js';
import { PUBLIC_HUD_READ_EXPRESSION, parsePublicHudRaw } from './hud-reader.js';

const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_MOVE_STEPS = 1;
const DEFAULT_DRAG_STEPS = 10;
const DEFAULT_KEY_TAP_HOLD_MS = 15;
const DEFAULT_CDP_CALL_TIMEOUT_MS = 1_800;

async function withCdpTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = DEFAULT_CDP_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Strictly read-only expression reading #game-input-overlay bounding rect.
 * No Network, Debugger, WebSocket, or Worker inspection is permitted.
 */
const OVERLAY_RECT_EXPRESSION = `(() => {
  const el = document.querySelector('#game-input-overlay');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
})()`;

const OverlayRectSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export interface CdpDispatchMouseEventParams {
  readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  readonly x: number;
  readonly y: number;
  readonly button?: 'none' | MouseButton;
  readonly buttons?: number;
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: number;
}

export interface CdpDispatchKeyEventParams {
  readonly type: 'keyDown' | 'keyUp' | 'rawKeyDown';
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly nativeVirtualKeyCode?: number;
  readonly modifiers?: number;
}

export interface CdpLayoutMetrics {
  readonly cssLayoutViewport?: {
    readonly clientWidth: number;
    readonly clientHeight: number;
    readonly pageX?: number;
    readonly pageY?: number;
  };
}

export interface CdpEvaluateResult {
  readonly result: {
    readonly type: string;
    readonly value?: unknown;
  };
  readonly exceptionDetails?: unknown;
}

/**
 * Narrow CDP client surface strictly restricted to Input, Page.getLayoutMetrics, and Runtime.evaluate.
 */
export interface CdpClientLike {
  readonly Input: {
    dispatchMouseEvent(params: CdpDispatchMouseEventParams): Promise<void>;
    dispatchKeyEvent(params: CdpDispatchKeyEventParams): Promise<void>;
  };
  readonly Page: {
    getLayoutMetrics(): Promise<CdpLayoutMetrics>;
  };
  readonly Runtime: {
    evaluate(params: { expression: string; returnByValue?: boolean }): Promise<CdpEvaluateResult>;
  };
  close(): Promise<void>;
}

export interface CdpActuatorOptions {
  readonly client: CdpClientLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly moveSteps?: number;
}

export interface CdpConnectOptions {
  readonly cdpUrl?: string;
  readonly targetUrlPrefix?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly moveSteps?: number;
}

const MODIFIER_BITMASK: Readonly<Record<KeyModifier, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const BUTTON_BITMASK: Readonly<Record<MouseButton, number>> = {
  left: 1,
  right: 2,
  middle: 4,
};

interface ResolvedKeyDescriptor {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly modifiers: number;
}

const SPECIAL_KEY_MAP: Readonly<Record<string, { key: string; vk: number }>> = {
  Space: { key: ' ', vk: 32 },
  Enter: { key: 'Enter', vk: 13 },
  NumpadEnter: { key: 'Enter', vk: 13 },
  Escape: { key: 'Escape', vk: 27 },
  Period: { key: '.', vk: 190 },
  Comma: { key: ',', vk: 188 },
  Minus: { key: '-', vk: 189 },
  Equal: { key: '=', vk: 187 },
  ArrowUp: { key: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', vk: 39 },
  ShiftLeft: { key: 'Shift', vk: 16 },
  ControlLeft: { key: 'Control', vk: 17 },
  AltLeft: { key: 'Alt', vk: 18 },
};

const MODIFIER_PREFIX_MAP: Readonly<Record<string, KeyModifier>> = {
  Alt: 'Alt',
  AltLeft: 'Alt',
  Control: 'Control',
  ControlLeft: 'Control',
  Ctrl: 'Control',
  Meta: 'Meta',
  Shift: 'Shift',
  ShiftLeft: 'Shift',
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function encodeModifiers(modifiers?: readonly KeyModifier[]): number {
  if (!modifiers || modifiers.length === 0) {
    return 0;
  }
  return modifiers.reduce((mask, mod) => mask | MODIFIER_BITMASK[mod], 0);
}

function resolveKeyDescriptor(
  keyOrCombo: string,
  extraModifiers?: readonly KeyModifier[],
): ResolvedKeyDescriptor {
  const parts = keyOrCombo.split('+').map((part) => part.trim()).filter(Boolean);
  const baseCode = parts[parts.length - 1] ?? keyOrCombo;
  const comboModifiers: KeyModifier[] = [];

  for (let i = 0; i < parts.length - 1; i += 1) {
    const token = parts[i];
    if (token !== undefined) {
      const mapped = MODIFIER_PREFIX_MAP[token];
      if (mapped !== undefined) {
        comboModifiers.push(mapped);
      }
    }
  }

  const allModifiers = [...comboModifiers, ...(extraModifiers ?? [])];
  const modifiers = encodeModifiers(allModifiers);

  const special = SPECIAL_KEY_MAP[baseCode];
  if (special !== undefined) {
    return {
      key: special.key,
      code: baseCode,
      windowsVirtualKeyCode: special.vk,
      modifiers,
    };
  }

  if (/^Key([A-Z])$/.test(baseCode)) {
    const letter = baseCode.slice(3);
    const isShifted = allModifiers.includes('Shift');
    return {
      key: isShifted ? letter.toUpperCase() : letter.toLowerCase(),
      code: baseCode,
      windowsVirtualKeyCode: letter.charCodeAt(0),
      modifiers,
    };
  }

  if (/^Digit([0-9])$/.test(baseCode)) {
    const digit = baseCode.slice(5);
    return {
      key: digit,
      code: baseCode,
      windowsVirtualKeyCode: digit.charCodeAt(0),
      modifiers,
    };
  }

  return {
    key: baseCode,
    code: baseCode,
    windowsVirtualKeyCode: baseCode.length === 1 ? baseCode.toUpperCase().charCodeAt(0) : 0,
    modifiers,
  };
}

function parseCdpHostPort(cdpUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new ActuatorError(`Invalid CDP URL "${cdpUrl}"`, 'CONNECTION_ERROR', { cdpUrl });
  }
  const host = parsed.hostname || DEFAULT_CDP_HOST;
  const port = parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_CDP_PORT;
  return { host, port };
}

/**
 * Direct Chrome DevTools Protocol actuator strictly restricted to Input dispatch,
 * Page.getLayoutMetrics, and Runtime.evaluate for #game-input-overlay bounds.
 */
export class CdpActuator implements BrowserActuator {
  private readonly client: CdpClientLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly moveSteps: number;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(options: CdpActuatorOptions) {
    this.client = options.client;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.moveSteps = Math.max(1, options.moveSteps ?? DEFAULT_MOVE_STEPS);
  }

  static async connect(options: CdpConnectOptions = {}): Promise<CdpActuator> {
    const { host, port } = parseCdpHostPort(
      options.cdpUrl ?? `http://${DEFAULT_CDP_HOST}:${DEFAULT_CDP_PORT}`,
    );

    let rawClient: CDP.Client;
    try {
      const targets = await CDP.List({ host, port });
      const pageTarget =
        targets.find(
          (t) =>
            t.type === 'page' &&
            (options.targetUrlPrefix
              ? t.url.startsWith(options.targetUrlPrefix)
              : !t.url.includes('/capture-client')),
        ) ?? targets.find((t) => t.type === 'page');

      rawClient = await CDP({
        host,
        port,
        ...(pageTarget ? { target: pageTarget.id } : {}),
      });
    } catch (error) {
      throw new ActuatorError('Failed to connect to Chrome DevTools Protocol', 'CONNECTION_ERROR', {
        host,
        port,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const restrictedClient: CdpClientLike = {
      Input: {
        dispatchMouseEvent: async (params) => {
          await rawClient.Input.dispatchMouseEvent(params);
        },
        dispatchKeyEvent: async (params) => {
          await rawClient.Input.dispatchKeyEvent(params);
        },
      },
      Page: {
        getLayoutMetrics: async () => {
          return rawClient.Page.getLayoutMetrics();
        },
      },
      Runtime: {
        evaluate: async (params) => {
          if (
            params.expression !== OVERLAY_RECT_EXPRESSION &&
            params.expression !== PUBLIC_HUD_READ_EXPRESSION
          ) {
            throw new ActuatorError(
              'Blocked non-allowlisted Runtime.evaluate expression',
              'UNSUPPORTED_PRIMITIVE',
            );
          }
          return rawClient.Runtime.evaluate(params);
        },
      },
      close: async () => {
        await rawClient.close();
      },
    };

    return new CdpActuator({
      client: restrictedClient,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.moveSteps !== undefined ? { moveSteps: options.moveSteps } : {}),
    });
  }

  async getViewportRect(): Promise<CanvasRect> {
    let evalResult: CdpEvaluateResult;
    try {
      evalResult = await withCdpTimeout(
        this.client.Runtime.evaluate({
          expression: OVERLAY_RECT_EXPRESSION,
          returnByValue: true,
        }),
        'CDP Runtime.evaluate',
      );
    } catch (error) {
      throw new ActuatorError('CDP Runtime.evaluate failed for #game-input-overlay', 'CDP_ERROR', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const rawValue = evalResult.result.value;
    if (rawValue !== null && rawValue !== undefined) {
      const parsed = OverlayRectSchema.safeParse(rawValue);
      if (!parsed.success) {
        throw new ViewportError('Invalid #game-input-overlay rect from CDP', parsed.error.issues);
      }
      return parsed.data;
    }

    // Fallback to Page.getLayoutMetrics when #game-input-overlay is not yet mounted (e.g. lobby)
    let metrics: Awaited<ReturnType<typeof this.client.Page.getLayoutMetrics>>;
    try {
      metrics = await withCdpTimeout(this.client.Page.getLayoutMetrics(), 'CDP Page.getLayoutMetrics');
    } catch (error) {
      throw new ActuatorError('CDP Page.getLayoutMetrics failed', 'CDP_ERROR', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const layout = metrics.cssLayoutViewport;
    if (!layout || !Number.isFinite(layout.clientWidth) || !Number.isFinite(layout.clientHeight)) {
      throw new ViewportError('CDP Page.getLayoutMetrics returned missing layout viewport');
    }
    if (layout.clientWidth <= 0 || layout.clientHeight <= 0) {
      throw new ViewportError('CDP layout viewport dimensions must be positive', layout);
    }

    return {
      left: 0,
      top: 0,
      width: layout.clientWidth,
      height: layout.clientHeight,
    };
  }

  async readPublicHud(): Promise<HudSnapshot | null> {
    try {
      const evalResult = await withCdpTimeout(
        this.client.Runtime.evaluate({
          expression: PUBLIC_HUD_READ_EXPRESSION,
          returnByValue: true,
        }),
        'CDP Runtime.evaluate HUD',
      );
      return parsePublicHudRaw(evalResult.result.value, Date.now());
    } catch {
      return null;
    }
  }

  async clickAt(x: number, y: number, options?: ClickOptions): Promise<void> {
    const button = options?.button ?? 'left';
    const clickCount = options?.clickCount ?? 1;
    const modifiers = encodeModifiers(options?.modifiers);
    const buttonsMask = BUTTON_BITMASK[button];

    await this.movePointerSmoothly(x, y, modifiers);

    await this.dispatchMouse({
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: buttonsMask,
      clickCount,
      modifiers,
    });
    await this.dispatchMouse({
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount,
      modifiers,
    });
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options?: DragOptions,
  ): Promise<void> {
    const button = options?.button ?? 'left';
    const steps = Math.max(1, options?.steps ?? DEFAULT_DRAG_STEPS);
    const stepDelayMs = options?.stepDelayMs ?? 0;
    const modifiers = encodeModifiers(options?.modifiers);
    const buttonsMask = BUTTON_BITMASK[button];

    await this.movePointerSmoothly(fromX, fromY, modifiers);
    await this.dispatchMouse({
      type: 'mousePressed',
      x: fromX,
      y: fromY,
      button,
      buttons: buttonsMask,
      clickCount: 1,
      modifiers,
    });

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const nx = Math.round(fromX + (toX - fromX) * t);
      const ny = Math.round(fromY + (toY - fromY) * t);
      await this.dispatchMouse({
        type: 'mouseMoved',
        x: nx,
        y: ny,
        button: 'none',
        buttons: buttonsMask,
        modifiers,
      });
      this.lastPointer = { x: nx, y: ny };
      if (stepDelayMs > 0) {
        await this.sleepFn(stepDelayMs);
      }
    }

    await this.dispatchMouse({
      type: 'mouseReleased',
      x: toX,
      y: toY,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers,
    });
    this.lastPointer = { x: toX, y: toY };
  }

  async wheelAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    options?: WheelOptions,
  ): Promise<void> {
    const modifiers = encodeModifiers(options?.modifiers);
    await this.movePointerSmoothly(x, y, modifiers);
    await this.dispatchMouse({
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      modifiers,
    });
  }

  async pressKey(key: string, options?: KeyPressOptions): Promise<void> {
    const descriptor = resolveKeyDescriptor(key, options?.modifiers);
    const holdMs = options?.holdMs ?? DEFAULT_KEY_TAP_HOLD_MS;

    await this.dispatchKey({
      type: 'keyDown',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers: descriptor.modifiers,
    });
    if (holdMs > 0) {
      await this.sleepFn(holdMs);
    }
    await this.dispatchKey({
      type: 'keyUp',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers: descriptor.modifiers,
    });
  }

  async holdKey(key: string, durationMs: number, options?: KeyHoldOptions): Promise<void> {
    await this.pressKey(key, {
      holdMs: Math.max(0, durationMs),
      ...(options?.modifiers !== undefined ? { modifiers: options.modifiers } : {}),
    });
  }

  async holdKeys(
    keys: readonly string[],
    durationMs: number,
    options?: KeyHoldOptions,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    if (keys.length === 1) {
      const onlyKey = keys[0];
      if (onlyKey !== undefined) {
        await this.holdKey(onlyKey, durationMs, options);
      }
      return;
    }

    const descriptors = keys.map((key) => resolveKeyDescriptor(key, options?.modifiers));
    for (const descriptor of descriptors) {
      await this.dispatchKey({
        type: 'keyDown',
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        modifiers: descriptor.modifiers,
      });
    }
    const clampedMs = Math.max(0, durationMs);
    if (clampedMs > 0) {
      await this.sleepFn(clampedMs);
    }
    for (const descriptor of [...descriptors].reverse()) {
      await this.dispatchKey({
        type: 'keyUp',
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        modifiers: descriptor.modifiers,
      });
    }
  }

  clickDomSelector(selector: string): Promise<void> {
    return Promise.reject(
      new ActuatorError(
        'CdpActuator restricts Runtime.evaluate strictly to #game-input-overlay; use McpActuator for DOM selectors',
        'UNSUPPORTED_PRIMITIVE',
        { selector },
      ),
    );
  }

  fillDomSelector(selector: string, _value: string): Promise<void> {
    return Promise.reject(
      new ActuatorError(
        'CdpActuator restricts Runtime.evaluate strictly to #game-input-overlay; use McpActuator for DOM selectors',
        'UNSUPPORTED_PRIMITIVE',
        { selector },
      ),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async movePointerSmoothly(
    targetX: number,
    targetY: number,
    modifiers: number,
  ): Promise<void> {
    const start = this.lastPointer;
    if (
      start !== null &&
      Math.abs(start.x - targetX) <= 1 &&
      Math.abs(start.y - targetY) <= 1
    ) {
      return;
    }
    if (start === null || this.moveSteps <= 1) {
      await this.dispatchMouse({
        type: 'mouseMoved',
        x: targetX,
        y: targetY,
        button: 'none',
        buttons: 0,
        modifiers,
      });
      this.lastPointer = { x: targetX, y: targetY };
      return;
    }

    for (let step = 1; step <= this.moveSteps; step += 1) {
      const t = step / this.moveSteps;
      const ix = Math.round(start.x + (targetX - start.x) * t);
      const iy = Math.round(start.y + (targetY - start.y) * t);
      await this.dispatchMouse({
        type: 'mouseMoved',
        x: ix,
        y: iy,
        button: 'none',
        buttons: 0,
        modifiers,
      });
    }
    this.lastPointer = { x: targetX, y: targetY };
  }

  private async dispatchMouse(params: CdpDispatchMouseEventParams): Promise<void> {
    try {
      await withCdpTimeout(
        this.client.Input.dispatchMouseEvent(params),
        'CDP Input.dispatchMouseEvent',
      );
    } catch (error) {
      throw new ActuatorError('CDP Input.dispatchMouseEvent failed', 'CDP_ERROR', {
        type: params.type,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchKey(params: CdpDispatchKeyEventParams): Promise<void> {
    try {
      await withCdpTimeout(
        this.client.Input.dispatchKeyEvent(params),
        'CDP Input.dispatchKeyEvent',
      );
    } catch (error) {
      throw new ActuatorError('CDP Input.dispatchKeyEvent failed', 'CDP_ERROR', {
        type: params.type,
        code: params.code,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
