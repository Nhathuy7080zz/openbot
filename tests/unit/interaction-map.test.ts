import { describe, expect, it } from 'vitest';
import {
  OPENFRONT_ATTACK_RATIO_BOUNDS,
  OPENFRONT_DIPLOMACY_ACTIONS,
  OPENFRONT_KEYBINDS,
  OPENFRONT_LOCAL_DEFAULTS,
  OPENFRONT_MOUSE_ACTIONS,
  OPENFRONT_STRUCTURES,
  OPENFRONT_UI_SELECTORS,
  getBuildableHotkey,
  getDiplomacyKeybind,
} from '../../src/game/interaction-map.js';

describe('OpenFront Verified Interaction Map', () => {
  it('pins local OpenFront dev endpoints strictly to loopback', () => {
    expect(OPENFRONT_LOCAL_DEFAULTS.clientUrl).toBe('http://localhost:9000');
    expect(OPENFRONT_LOCAL_DEFAULTS.masterPort).toBe(3000);
    expect(OPENFRONT_LOCAL_DEFAULTS.workerPorts).toEqual([3001, 3002]);
  });

  it('maps Digit1..Digit0 structure and weapon hotkeys matching UserSettings.ts', () => {
    expect(getBuildableHotkey('city')).toBe('Digit1');
    expect(getBuildableHotkey('factory')).toBe('Digit2');
    expect(getBuildableHotkey('port')).toBe('Digit3');
    expect(getBuildableHotkey('defense_post')).toBe('Digit4');
    expect(getBuildableHotkey('missile_silo')).toBe('Digit5');
    expect(getBuildableHotkey('sam_launcher')).toBe('Digit6');
    expect(getBuildableHotkey('warship')).toBe('Digit7');
    expect(getBuildableHotkey('atom_bomb')).toBe('Digit8');
    expect(getBuildableHotkey('hydrogen_bomb')).toBe('Digit9');
    expect(getBuildableHotkey('mirv')).toBe('Digit0');

    expect(OPENFRONT_STRUCTURES.city.unitType).toBe('City');
    expect(OPENFRONT_STRUCTURES.sam_launcher.unitType).toBe('SAM Launcher');
    expect(OPENFRONT_STRUCTURES.missile_silo.unitType).toBe('Missile Silo');
    expect(OPENFRONT_STRUCTURES.defense_post.unitType).toBe('Defense Post');
  });

  it('maps diplomacy actions and attack ratio bounds accurately', () => {
    expect(getDiplomacyKeybind('request_alliance')).toBe('KeyK');
    expect(getDiplomacyKeybind('break_alliance')).toBe('KeyL');
    expect(getDiplomacyKeybind('target_player')).toBe('KeyN');
    expect(getDiplomacyKeybind('donate_troops')).toBe('KeyJ');
    expect(getDiplomacyKeybind('donate_gold')).toBe('KeyO');
    expect(OPENFRONT_DIPLOMACY_ACTIONS.embargo.viaRadialOrPanel).toBe(true);

    expect(OPENFRONT_KEYBINDS.attackRatioDown).toBe('KeyT');
    expect(OPENFRONT_KEYBINDS.attackRatioUp).toBe('KeyY');
    expect(OPENFRONT_KEYBINDS.coordinateGrid).toBe('KeyM');
    expect(OPENFRONT_KEYBINDS.toggleView).toBe('Space');

    expect(OPENFRONT_ATTACK_RATIO_BOUNDS).toEqual({
      minPercent: 1,
      maxPercent: 100,
      defaultPercent: 20,
      incrementPercent: 10,
    });
  });

  it('documents verified mouse gestures and DOM/Lit selectors', () => {
    expect(OPENFRONT_MOUSE_ACTIONS.leftClick.button).toBe('left');
    expect(OPENFRONT_MOUSE_ACTIONS.rightClickRadial.button).toBe('right');
    expect(OPENFRONT_MOUSE_ACTIONS.dragPan.dragThresholdPx).toBe(10);

    expect(OPENFRONT_UI_SELECTORS.inputOverlay).toBe('#game-input-overlay');
    expect(OPENFRONT_UI_SELECTORS.controlPanel).toBe('control-panel');
    expect(OPENFRONT_UI_SELECTORS.hostLobbyModal).toBe('host-lobby-modal');
    expect(OPENFRONT_UI_SELECTORS.joinLobbyModal).toBe('join-lobby-modal');
    expect(OPENFRONT_UI_SELECTORS.lobbyIdInput).toBe('#lobbyIdInput');
  });
});
