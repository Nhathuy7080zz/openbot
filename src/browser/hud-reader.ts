import { z } from 'zod';
import { HudSnapshotSchema, type HudSnapshot } from '../harness/contract-loader.js';

/**
 * Strictly read-only expression reading ONLY visibly rendered public Lit HUD DOM elements
 * (ControlPanel, GameRightSidebar, WinModal). Zero internal game state, workers, or network access.
 */
export const PUBLIC_HUD_READ_EXPRESSION = `(() => {
  const clean = (el) => (el && typeof el.textContent === 'string' ? el.textContent.trim() || null : null);
  const panelEl = document.querySelector('control-panel [data-control-panel]') || document.querySelector('control-panel');
  const panelVisible = Boolean(
    panelEl && !panelEl.classList.contains('hidden') && !panelEl.hasAttribute('hidden')
  );
  const goldCaps = document.querySelectorAll('control-panel [data-gold] .hud-caps');
  const goldEl = goldCaps.length > 0 ? goldCaps[goldCaps.length - 1] : document.querySelector('control-panel [data-gold]');
  const goldText = clean(goldEl);
  const troopsText = clean(document.querySelector('control-panel [data-troops]'));
  const maxTroopsText = clean(document.querySelector('control-panel [data-max-troops]'));
  const troopRateText = clean(document.querySelector('control-panel [data-troop-rate]'));
  const ratioSlider = document.querySelector('control-panel input[type="range"]');
  const attackRatioText = ratioSlider && 'value' in ratioSlider && String(ratioSlider.value).length > 0
    ? String(ratioSlider.value)
    : (ratioSlider?.getAttribute('aria-valuetext') ?? clean(document.querySelector('control-panel [data-attack-ratio-label]')));
  const matchTimerText = clean(document.querySelector('[data-game-timer]'));

  const winModal = document.querySelector('win-modal');
  const winDialog = winModal ? winModal.querySelector('[role="dialog"]') : null;
  const dialogHidden = winDialog ? Boolean(winDialog.closest('.hidden, [hidden]')) : true;
  const gameOver = Boolean(winDialog && !dialogHidden && getComputedStyle(winDialog).display !== 'none');
  const gameOverText = gameOver
    ? (winDialog?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120) || 'Game Over'
    : null;

  return {
    panelVisible,
    gameOver,
    goldText,
    troopsText,
    maxTroopsText,
    troopRateText,
    attackRatioText,
    matchTimerText,
    gameOverText,
  };
})()`;

export interface PublicHudRaw {
  readonly panelVisible: boolean;
  readonly gameOver: boolean;
  readonly goldText: string | null;
  readonly troopsText: string | null;
  readonly maxTroopsText: string | null;
  readonly troopRateText: string | null;
  readonly attackRatioText: string | null;
  readonly matchTimerText: string | null;
  readonly gameOverText: string | null;
}

export type PublicHudSnapshot = HudSnapshot;

const PublicHudRawSchema = z.object({
  panelVisible: z.boolean(),
  gameOver: z.boolean(),
  goldText: z.string().nullable().optional().default(null),
  troopsText: z.string().nullable().optional().default(null),
  maxTroopsText: z.string().nullable().optional().default(null),
  troopRateText: z.string().nullable().optional().default(null),
  attackRatioText: z.string().nullable().optional().default(null),
  matchTimerText: z.string().nullable().optional().default(null),
  gameOverText: z.string().nullable().optional().default(null),
});

const COMPACT_NUMBER_RE = /^([\d,.]+)\s*([KMBT])?$/i;

const UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
  T: 1_000_000_000_000,
};

/**
 * Parses compact rendered HUD quantities like "0", "1,250", "185.5K", "3.4M", "1.25B".
 */
export function parseCompactHudNumber(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = COMPACT_NUMBER_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const numeric = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  const suffix = match[2]?.toUpperCase();
  const mult = suffix !== undefined ? (UNIT_MULTIPLIER[suffix] ?? 1) : 1;
  return Math.round(numeric * mult);
}

function parseAttackRatioPct(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const cleaned = raw.replace(/%/g, '').trim();
  if (cleaned.length === 0) {
    return null;
  }
  const parsed = Math.round(Number(cleaned));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return null;
  }
  return parsed;
}

/**
 * Normalizes a raw public HUD DOM evaluation payload into a contract-validated HudSnapshot.
 */
export function parsePublicHudRaw(raw: unknown, timestampMs = Date.now()): HudSnapshot | null {
  const parsed = PublicHudRawSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  const candidate = {
    type: 'hud_snapshot' as const,
    timestamp_ms: Math.max(0, timestampMs),
    panel_visible: data.panelVisible,
    game_over: data.gameOver,
    gold: parseCompactHudNumber(data.goldText),
    gold_text: data.goldText,
    troops: parseCompactHudNumber(data.troopsText),
    max_troops: parseCompactHudNumber(data.maxTroopsText),
    troop_rate: data.troopRateText,
    attack_ratio_pct: parseAttackRatioPct(data.attackRatioText),
    match_timer: data.matchTimerText,
    game_over_text: data.gameOverText,
  };
  const validated = HudSnapshotSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

/**
 * Formats a compact 1-line HUD status header for tactical System 1 / System 2 prompts.
 */
export function formatHudHeaderLine(hud: HudSnapshot): string {
  if (hud.game_over) {
    return `[HUD: GAME_OVER timer=${hud.match_timer ?? '?'} gold=${hud.gold_text ?? '?'} detail=${hud.game_over_text ?? 'ended'}]`;
  }
  const timer = hud.match_timer ?? '?';
  const gold = hud.gold_text ?? (hud.gold !== null && hud.gold !== undefined ? String(hud.gold) : '?');
  const troops = hud.troops !== null && hud.troops !== undefined ? String(hud.troops) : '?';
  const maxTroops =
    hud.max_troops !== null && hud.max_troops !== undefined ? String(hud.max_troops) : '?';
  const troopsDisplay =
    hud.panel_visible && hud.troop_rate
      ? `${troops}/${maxTroops} (${hud.troop_rate})`
      : `${troops}/${maxTroops}`;
  const ratio =
    hud.attack_ratio_pct !== null && hud.attack_ratio_pct !== undefined
      ? `${hud.attack_ratio_pct}%`
      : '?';
  const panelState = hud.panel_visible ? 'active' : 'spawn_or_hidden';
  return `[HUD: timer=${timer} gold=${gold} troops=${troopsDisplay} ratio=${ratio} panel=${panelState}]`;
}
