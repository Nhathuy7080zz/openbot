export const OPENFRONT_LOCAL_DEFAULTS = {
  clientUrl: 'http://localhost:9000',
  clientPort: 9000,
  masterPort: 3000,
  workerPorts: [3001, 3002],
  devCommand: 'npm run dev',
  installCommandNode24: 'npm run inst',
  installCommandNode26Override: 'npm ci --ignore-scripts --engine-strict=false',
} as const;

export const OPENFRONT_ATTACK_RATIO_BOUNDS = {
  minPercent: 1,
  maxPercent: 100,
  defaultPercent: 20,
  incrementPercent: 10,
} as const;

/**
 * Verified default keybinds from vendor/OpenFrontIO/src/client/UserSettings.ts (getDefaultKeybinds).
 * Uses KeyboardEvent.code physical key identifiers.
 */
export const OPENFRONT_KEYBINDS = {
  toggleView: 'Space',
  preventStacking: 'KeyH',
  coordinateGrid: 'KeyM',
  performanceOverlay: 'Shift+KeyD',
  buildCity: 'Digit1',
  buildFactory: 'Digit2',
  buildPort: 'Digit3',
  buildDefensePost: 'Digit4',
  buildMissileSilo: 'Digit5',
  buildSamLauncher: 'Digit6',
  buildWarship: 'Digit7',
  buildAtomBomb: 'Digit8',
  buildHydrogenBomb: 'Digit9',
  buildMIRV: 'Digit0',
  attackRatioDown: 'KeyT',
  attackRatioUp: 'KeyY',
  boatAttack: 'KeyB',
  groundAttack: 'KeyG',
  retaliateAttack: 'Shift+KeyR',
  requestAlliance: 'KeyK',
  breakAlliance: 'KeyL',
  targetPlayer: 'KeyN',
  donateTroops: 'KeyJ',
  donateGold: 'KeyO',
  emojiMenu: 'KeyF',
  quickChat: 'KeyR',
  playerPanel: 'KeyI',
  swapDirection: 'KeyU',
  zoomOut: 'KeyQ',
  zoomIn: 'KeyE',
  centerCamera: 'KeyC',
  moveUp: 'KeyW',
  moveLeft: 'KeyA',
  moveDown: 'KeyS',
  moveRight: 'KeyD',
  pauseGame: 'KeyP',
  gameSpeedUp: 'Period',
  gameSpeedDown: 'Comma',
  selectAllWarships: 'KeyX',
  buildMenuModifierWinLinux: 'ControlLeft',
  boxSelectWarshipsModifier: 'ShiftLeft',
  cancelOrClose: 'Escape',
  confirmGhostStructure: 'Enter',
} as const;

export const OPENFRONT_MOUSE_ACTIONS = {
  leftClick: {
    button: 'left',
    purpose: 'Select spawn point, ground attack target, or confirm ghost structure placement',
  },
  rightClickRadial: {
    button: 'right',
    purpose: 'Open radial menu at cursor, cancel ghost structure, or clear warship selection',
  },
  middleClickAutoUpgrade: {
    button: 'middle',
    purpose: 'Trigger AutoUpgradeEvent at cursor coordinates',
  },
  ctrlLeftClickBuildMenu: {
    button: 'left',
    modifier: 'ControlLeft',
    purpose: 'Open BuildMenu modal at cursor coordinates (Windows/Linux)',
  },
  dragPan: {
    button: 'left',
    dragThresholdPx: 10,
    purpose: 'Pan map camera when pointer drag distance >= 10px',
  },
  shiftDragWarshipBox: {
    button: 'left',
    modifier: 'ShiftLeft',
    dragThresholdPx: 10,
    purpose: 'Draw warship multi-selection rectangle',
  },
  wheelZoom: {
    purpose: 'Zoom camera centered at cursor (deltaY >= 2px)',
  },
  shiftWheelAttackRatio: {
    modifier: 'ShiftLeft',
    purpose: 'Adjust attack ratio by +/-10% increment',
  },
} as const;

export type BuildableKey =
  | 'city'
  | 'factory'
  | 'port'
  | 'defense_post'
  | 'missile_silo'
  | 'sam_launcher'
  | 'warship'
  | 'atom_bomb'
  | 'hydrogen_bomb'
  | 'mirv';

export interface BuildableDescriptor {
  readonly key: BuildableKey;
  readonly unitType: string;
  readonly category: 'structure' | 'attack_unit';
  readonly hotkey: string;
  readonly baseGoldCost: number;
}

export const OPENFRONT_STRUCTURES: Readonly<Record<BuildableKey, BuildableDescriptor>> = {
  city: {
    key: 'city',
    unitType: 'City',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildCity,
    baseGoldCost: 125_000,
  },
  factory: {
    key: 'factory',
    unitType: 'Factory',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildFactory,
    baseGoldCost: 125_000,
  },
  port: {
    key: 'port',
    unitType: 'Port',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildPort,
    baseGoldCost: 125_000,
  },
  defense_post: {
    key: 'defense_post',
    unitType: 'Defense Post',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildDefensePost,
    baseGoldCost: 50_000,
  },
  missile_silo: {
    key: 'missile_silo',
    unitType: 'Missile Silo',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildMissileSilo,
    baseGoldCost: 1_000_000,
  },
  sam_launcher: {
    key: 'sam_launcher',
    unitType: 'SAM Launcher',
    category: 'structure',
    hotkey: OPENFRONT_KEYBINDS.buildSamLauncher,
    baseGoldCost: 1_500_000,
  },
  warship: {
    key: 'warship',
    unitType: 'Warship',
    category: 'attack_unit',
    hotkey: OPENFRONT_KEYBINDS.buildWarship,
    baseGoldCost: 250_000,
  },
  atom_bomb: {
    key: 'atom_bomb',
    unitType: 'Atom Bomb',
    category: 'attack_unit',
    hotkey: OPENFRONT_KEYBINDS.buildAtomBomb,
    baseGoldCost: 750_000,
  },
  hydrogen_bomb: {
    key: 'hydrogen_bomb',
    unitType: 'Hydrogen Bomb',
    category: 'attack_unit',
    hotkey: OPENFRONT_KEYBINDS.buildHydrogenBomb,
    baseGoldCost: 5_000_000,
  },
  mirv: {
    key: 'mirv',
    unitType: 'MIRV',
    category: 'attack_unit',
    hotkey: OPENFRONT_KEYBINDS.buildMIRV,
    baseGoldCost: 25_000_000,
  },
} as const;

export type DiplomacyActionKey =
  | 'request_alliance'
  | 'break_alliance'
  | 'target_player'
  | 'donate_troops'
  | 'donate_gold'
  | 'embargo';

export interface DiplomacyActionDescriptor {
  readonly key: DiplomacyActionKey;
  readonly hotkey: string | null;
  readonly viaRadialOrPanel: boolean;
}

export const OPENFRONT_DIPLOMACY_ACTIONS: Readonly<
  Record<DiplomacyActionKey, DiplomacyActionDescriptor>
> = {
  request_alliance: {
    key: 'request_alliance',
    hotkey: OPENFRONT_KEYBINDS.requestAlliance,
    viaRadialOrPanel: true,
  },
  break_alliance: {
    key: 'break_alliance',
    hotkey: OPENFRONT_KEYBINDS.breakAlliance,
    viaRadialOrPanel: true,
  },
  target_player: {
    key: 'target_player',
    hotkey: OPENFRONT_KEYBINDS.targetPlayer,
    viaRadialOrPanel: true,
  },
  donate_troops: {
    key: 'donate_troops',
    hotkey: OPENFRONT_KEYBINDS.donateTroops,
    viaRadialOrPanel: true,
  },
  donate_gold: {
    key: 'donate_gold',
    hotkey: OPENFRONT_KEYBINDS.donateGold,
    viaRadialOrPanel: true,
  },
  embargo: {
    key: 'embargo',
    hotkey: null,
    viaRadialOrPanel: true,
  },
} as const;

/**
 * Verified DOM & Lit custom-element selectors from index.html, ClientGameRunner.ts,
 * ControlPanel.ts, HostLobbyModal.ts, JoinLobbyModal.ts, SinglePlayerModal.ts.
 */
export const OPENFRONT_UI_SELECTORS = {
  inputOverlay: '#game-input-overlay',
  playPage: 'play-page',
  gameModeSelector: 'game-mode-selector',
  singlePlayerModal: 'single-player-modal',
  hostLobbyModal: 'host-lobby-modal',
  joinLobbyModal: 'join-lobby-modal',
  lobbyIdInput: '#lobbyIdInput',
  controlPanel: 'control-panel',
  controlPanelRoot: '[data-control-panel]',
  attackRatioSlider: 'control-panel input[type="range"]',
  attackRatioTrack: '[data-ratio-track]',
  troopBar: '[data-troop-bar]',
  goldChip: '[data-gold]',
  buildMenu: 'build-menu',
  playerPanel: 'player-panel',
  winModal: 'win-modal',
  gameStartingModal: 'game-starting-modal',
} as const;

export function getBuildableHotkey(key: BuildableKey): string {
  return OPENFRONT_STRUCTURES[key].hotkey;
}

export function getDiplomacyKeybind(key: DiplomacyActionKey): string | null {
  return OPENFRONT_DIPLOMACY_ACTIONS[key].hotkey;
}

export function getAttackRatioBounds(): typeof OPENFRONT_ATTACK_RATIO_BOUNDS {
  return OPENFRONT_ATTACK_RATIO_BOUNDS;
}
