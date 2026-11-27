import CDP from 'chrome-remote-interface';
import { ActuatorError } from '../errors/app-error.js';
import { OPENFRONT_UI_SELECTORS } from '../game/interaction-map.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

const OVERLAY_READY_EXPRESSION = `(() => {
  const el = document.querySelector('${OPENFRONT_UI_SELECTORS.inputOverlay}');
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
})()`;

const SOLO_BUTTON_SELECTORS: readonly string[] = [
  `${OPENFRONT_UI_SELECTORS.gameModeSelector} button`,
  `${OPENFRONT_UI_SELECTORS.gameModeSelector} [role="button"]`,
  `${OPENFRONT_UI_SELECTORS.playPage} button`,
  'button',
  '[role="button"]',
];
const SOLO_TEXT_HINTS: readonly string[] = [
  'solo',
  'single player',
  'singleplayer',
  'chơi đơn',
];

const START_BUTTON_SELECTORS: readonly string[] = [
  `${OPENFRONT_UI_SELECTORS.singlePlayerModal} o-button`,
  `${OPENFRONT_UI_SELECTORS.singlePlayerModal} button`,
  '[translationKey="game_settings.start"]',
  'o-button[variant="primary"]',
  'o-button',
];
const START_TEXT_HINTS: readonly string[] = ['start', 'play', 'bắt đầu'];

export interface LobbyPageAdapter {
  navigate(url: string): Promise<void>;
  evaluateBool(expression: string): Promise<boolean>;
  clickFirstMatching(
    selectors: readonly string[],
    textIncludes?: readonly string[],
  ): Promise<boolean>;
}

export interface LobbyNavigatorOptions {
  readonly adapter: LobbyPageAdapter;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface LobbyJoinOptions {
  readonly targetUrl: string;
  readonly lobbyUrl?: string;
}

export interface LobbyJoinResult {
  readonly mode: 'direct_lobby_url' | 'local_solo_auto';
  readonly navigatedUrl: string;
}

export interface CdpLobbyClientLike {
  readonly Page: {
    navigate(params: { url: string }): Promise<unknown>;
  };
  readonly Runtime: {
    evaluate(params: {
      expression: string;
      returnByValue?: boolean;
    }): Promise<{ result?: { value?: unknown } }>;
  };
  close(): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildClickExpression(
  selectors: readonly string[],
  textIncludes: readonly string[],
): string {
  const selectorsJson = JSON.stringify(selectors);
  const hintsJson = JSON.stringify(textIncludes.map((hint) => hint.toLowerCase()));
  return `(() => {
    const selectors = ${selectorsJson};
    const hints = ${hintsJson};
    const roots = [document];
    const seen = new Set();
    const allElements = [];

    const collectFromRoot = (root) => {
      for (const sel of selectors) {
        let matches = [];
        try {
          matches = Array.from(root.querySelectorAll(sel));
        } catch {
          matches = [];
        }
        for (const el of matches) {
          if (!seen.has(el)) {
            seen.add(el);
            allElements.push(el);
          }
        }
      }
      const tree = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const node of tree) {
        if (node && node.shadowRoot) {
          roots.push(node.shadowRoot);
        }
      }
    };

    for (let i = 0; i < roots.length; i += 1) {
      collectFromRoot(roots[i]);
    }

    const isInteractable = (el) => {
      if (!el || typeof el.click !== 'function') return false;
      if (el.disabled === true) return false;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };

    const candidates = allElements.filter(isInteractable);
    if (candidates.length === 0) return false;

    let chosen = null;
    if (hints.length > 0) {
      chosen = candidates.find((el) => {
        const text = (el.textContent || '').toLowerCase();
        const tKey = (el.getAttribute && el.getAttribute('translationKey') || '').toLowerCase();
        return hints.some((h) => text.includes(h) || tKey.includes(h));
      }) || null;
    } else {
      chosen = candidates[0] || null;
    }

    if (!chosen) return false;
    chosen.click();
    return true;
  })()`;
}

/**
 * CDP adapter strictly used for lobby navigation and clicking Solo/Start UI buttons before match entry.
 */
export class CdpLobbyPageAdapter implements LobbyPageAdapter {
  private readonly client: CdpLobbyClientLike;

  constructor(client: CdpLobbyClientLike) {
    this.client = client;
  }

  static async connect(options: {
    readonly cdpUrl: string;
    readonly targetUrlPrefix?: string;
  }): Promise<CdpLobbyPageAdapter> {
    const parsed = new URL(options.cdpUrl);
    const host = parsed.hostname || '127.0.0.1';
    const port = parsed.port.length > 0 ? Number(parsed.port) : 9222;

    const targets = await CDP.List({ host, port });
    const pageTarget =
      targets.find(
        (t) =>
          t.type === 'page' &&
          (options.targetUrlPrefix
            ? t.url.startsWith(options.targetUrlPrefix)
            : !t.url.includes('/capture-client')),
      ) ?? targets.find((t) => t.type === 'page');

    if (!pageTarget) {
      throw new ActuatorError('No page target found on CDP for LobbyNavigator', 'CONNECTION_ERROR');
    }

    const rawClient = await CDP({ host, port, target: pageTarget.id });
    return new CdpLobbyPageAdapter({
      Page: {
        navigate: (params) => rawClient.Page.navigate(params),
      },
      Runtime: {
        evaluate: (params) => rawClient.Runtime.evaluate(params),
      },
      close: () => rawClient.close(),
    });
  }

  async navigate(url: string): Promise<void> {
    await this.client.Page.navigate({ url });
  }

  async evaluateBool(expression: string): Promise<boolean> {
    const res = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return Boolean(res.result?.value);
  }

  async clickFirstMatching(
    selectors: readonly string[],
    textIncludes: readonly string[] = [],
  ): Promise<boolean> {
    const expression = buildClickExpression(selectors, textIncludes);
    return this.evaluateBool(expression);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Navigates OpenFront either directly to a --lobby-url or automatically through Solo -> Start.
 */
export class LobbyNavigator {
  private readonly adapter: LobbyPageAdapter;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: LobbyNavigatorOptions) {
    this.adapter = options.adapter;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async joinLobby(options: LobbyJoinOptions): Promise<LobbyJoinResult> {
    const deadline = this.now() + this.timeoutMs;

    if (options.lobbyUrl) {
      await this.adapter.navigate(options.lobbyUrl);
      await this.waitForOverlay(deadline, options.lobbyUrl);
      return {
        mode: 'direct_lobby_url',
        navigatedUrl: options.lobbyUrl,
      };
    }

    await this.adapter.navigate(options.targetUrl);
    await this.clickWithRetry(SOLO_BUTTON_SELECTORS, SOLO_TEXT_HINTS, deadline, 'Solo mode button');
    await this.clickWithRetry(
      START_BUTTON_SELECTORS,
      START_TEXT_HINTS,
      deadline,
      'Single-player Start button',
    );
    await this.waitForOverlay(deadline, options.targetUrl);

    return {
      mode: 'local_solo_auto',
      navigatedUrl: options.targetUrl,
    };
  }

  private async clickWithRetry(
    selectors: readonly string[],
    textIncludes: readonly string[],
    deadline: number,
    label: string,
  ): Promise<void> {
    while (true) {
      const clicked = await this.adapter.clickFirstMatching(selectors, textIncludes);
      if (clicked) {
        return;
      }
      if (this.now() >= deadline) {
        throw new ActuatorError(
          `Timed out waiting to click ${label} within ${this.timeoutMs}ms`,
          'ACTUATOR_ERROR',
        );
      }
      await this.sleepFn(this.pollIntervalMs);
    }
  }

  private async waitForOverlay(deadline: number, url: string): Promise<void> {
    while (true) {
      const ready = await this.adapter.evaluateBool(OVERLAY_READY_EXPRESSION);
      if (ready) {
        return;
      }
      if (this.now() >= deadline) {
        throw new ActuatorError(
          `Timed out waiting for ${OPENFRONT_UI_SELECTORS.inputOverlay} at ${url} within ${this.timeoutMs}ms`,
          'ACTUATOR_ERROR',
          { url, timeoutMs: this.timeoutMs },
        );
      }
      await this.sleepFn(this.pollIntervalMs);
    }
  }
}
