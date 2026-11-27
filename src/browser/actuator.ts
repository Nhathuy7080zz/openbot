import type { CanvasRect } from '../game/coordinate-mapper.js';
import type { HudSnapshot } from '../harness/contract-loader.js';

export type MouseButton = 'left' | 'right' | 'middle';
export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface ClickOptions {
  readonly button?: MouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly KeyModifier[];
}

export interface DragOptions {
  readonly button?: MouseButton;
  readonly steps?: number;
  readonly stepDelayMs?: number;
  readonly modifiers?: readonly KeyModifier[];
}

export interface WheelOptions {
  readonly modifiers?: readonly KeyModifier[];
}

export interface KeyPressOptions {
  readonly modifiers?: readonly KeyModifier[];
  readonly holdMs?: number;
}

export interface KeyHoldOptions {
  readonly modifiers?: readonly KeyModifier[];
}

/**
 * Unified browser actuation contract implemented by MCP, CDP, and Fallback adapters.
 */
export interface BrowserActuator {
  getViewportRect(): Promise<CanvasRect>;
  clickAt(x: number, y: number, options?: ClickOptions): Promise<void>;
  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options?: DragOptions,
  ): Promise<void>;
  wheelAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    options?: WheelOptions,
  ): Promise<void>;
  pressKey(key: string, options?: KeyPressOptions): Promise<void>;
  holdKey(key: string, durationMs: number, options?: KeyHoldOptions): Promise<void>;
  holdKeys?(keys: readonly string[], durationMs: number, options?: KeyHoldOptions): Promise<void>;
  readPublicHud?(): Promise<HudSnapshot | null>;
  clickDomSelector(selector: string): Promise<void>;
  fillDomSelector(selector: string, value: string): Promise<void>;
  close(): Promise<void>;
}
