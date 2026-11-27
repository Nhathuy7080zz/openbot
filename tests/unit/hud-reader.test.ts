import { describe, expect, it } from 'vitest';
import {
  PUBLIC_HUD_READ_EXPRESSION,
  formatHudHeaderLine,
  parseCompactHudNumber,
  parsePublicHudRaw,
} from '../../src/browser/hud-reader.js';

describe('Public HUD Reader (Fair-Play Lit DOM)', () => {
  it('parses compact OpenFront HUD numbers accurately', () => {
    expect(parseCompactHudNumber('0')).toBe(0);
    expect(parseCompactHudNumber('1,250')).toBe(1250);
    expect(parseCompactHudNumber('12.5K')).toBe(12_500);
    expect(parseCompactHudNumber(' 3.4M ')).toBe(3_400_000);
    expect(parseCompactHudNumber('1.25B')).toBe(1_250_000_000);
    expect(parseCompactHudNumber('+2.1K/s')).toBeNull();
    expect(parseCompactHudNumber('')).toBeNull();
    expect(parseCompactHudNumber(null)).toBeNull();
  });

  it('normalizes raw public Lit DOM snapshot into HudSnapshot and formats a 1-line header', () => {
    const hud = parsePublicHudRaw(
      {
        panelVisible: true,
        gameOver: false,
        goldText: '185.5K',
        troopsText: '42.0K',
        maxTroopsText: '120K',
        troopRateText: '+1.8K/s',
        attackRatioText: '30',
        matchTimerText: '02:14',
        gameOverText: null,
      },
      12_345,
    );

    expect(hud.type).toBe('hud_snapshot');
    expect(hud.timestamp_ms).toBe(12_345);
    expect(hud.panel_visible).toBe(true);
    expect(hud.game_over).toBe(false);
    expect(hud.gold).toBe(185_500);
    expect(hud.gold_text).toBe('185.5K');
    expect(hud.troops).toBe(42_000);
    expect(hud.max_troops).toBe(120_000);
    expect(hud.troop_rate).toBe('+1.8K/s');
    expect(hud.attack_ratio_pct).toBe(30);
    expect(hud.match_timer).toBe('02:14');

    const line = formatHudHeaderLine(hud);
    expect(line).toBe(
      '[HUD: timer=02:14 gold=185.5K troops=42000/120000 (+1.8K/s) ratio=30% panel=active]',
    );
  });

  it('handles spawn/hidden panel and game_over win-modal state cleanly', () => {
    const spawnHud = parsePublicHudRaw(
      {
        panelVisible: false,
        gameOver: false,
        goldText: null,
        troopsText: null,
        maxTroopsText: null,
        troopRateText: null,
        attackRatioText: null,
        matchTimerText: '00:05',
        gameOverText: null,
      },
      100,
    );
    expect(spawnHud.panel_visible).toBe(false);
    expect(formatHudHeaderLine(spawnHud)).toContain('panel=spawn_or_hidden');

    const overHud = parsePublicHudRaw(
      {
        panelVisible: false,
        gameOver: true,
        goldText: '0',
        troopsText: '0',
        maxTroopsText: '100K',
        troopRateText: null,
        attackRatioText: '20%',
        matchTimerText: '06:40',
        gameOverText: 'You were eliminated',
      },
      200,
    );
    expect(overHud.game_over).toBe(true);
    expect(overHud.attack_ratio_pct).toBe(20);
    expect(formatHudHeaderLine(overHud)).toContain('GAME_OVER');
  });

  it('keeps PUBLIC_HUD_READ_EXPRESSION strictly limited to public Lit DOM selectors', () => {
    expect(PUBLIC_HUD_READ_EXPRESSION).toContain('control-panel');
    expect(PUBLIC_HUD_READ_EXPRESSION).toContain('win-modal');
    expect(PUBLIC_HUD_READ_EXPRESSION).not.toContain('window.game');
    expect(PUBLIC_HUD_READ_EXPRESSION).not.toContain('myPlayer');
    expect(PUBLIC_HUD_READ_EXPRESSION).not.toContain('Worker');
  });
});
