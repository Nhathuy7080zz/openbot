export {
  ActuatorError,
  AppError,
  ConfigValidationError,
  FairPlayGuardError,
  RateLimitExceededError,
  ToolValidationError,
  ViewportError,
  type ActuatorErrorCode,
} from './errors/app-error.js';
export {
  assertTargetAllowed,
  loadConfig,
  redactConfig,
  type OpenBotConfig,
  type RedactedOpenBotConfig,
  type TargetGuardOptions,
} from './config/env.js';
export {
  OPENFRONT_ATTACK_RATIO_BOUNDS,
  OPENFRONT_DIPLOMACY_ACTIONS,
  OPENFRONT_KEYBINDS,
  OPENFRONT_LOCAL_DEFAULTS,
  OPENFRONT_MOUSE_ACTIONS,
  OPENFRONT_STRUCTURES,
  OPENFRONT_UI_SELECTORS,
  getAttackRatioBounds,
  getBuildableHotkey,
  getDiplomacyKeybind,
  type BuildableDescriptor,
  type BuildableKey,
  type DiplomacyActionDescriptor,
  type DiplomacyActionKey,
} from './game/interaction-map.js';
export {
  CoordinateMapper,
  type CanvasRect,
  type CoordinateMapperOptions,
  type NormalizedPoint,
  type PixelPoint,
  type RectUpdateResult,
} from './game/coordinate-mapper.js';
export {
  ACTION_PROTOCOL,
  ActionProtocolSchema,
  ActionRequestSchema,
  ActionResponseSchema,
  HudSnapshotSchema,
  PingPongSchema,
  RecoverySchema,
  SessionStatusSchema,
  TOOL_NAMES,
  loadActionProtocol,
  type ActionProtocol,
  type ActionRequest,
  type ActionResponse,
  type HudSnapshot,
  type PingPongMessage,
  type RecoveryContract,
  type SessionStatus,
  type ToolName,
} from './harness/contract-loader.js';
export {
  AttackTerritoryArgsSchema,
  BuildStructureArgsSchema,
  CameraControlArgsSchema,
  DiplomacyActionArgsSchema,
  ExecutePlanArgsSchema,
  ExecutePlanStepSchema,
  ExpandBurstArgsSchema,
  FocusRegionArgsSchema,
  LaunchSpecialArgsSchema,
  PanMapArgsSchema,
  ResetOverviewArgsSchema,
  SelectSpawnArgsSchema,
  SetAttackRatioArgsSchema,
  TOOL_ARG_SCHEMAS,
  WaitObserveArgsSchema,
  ZoomMapArgsSchema,
  type AttackTerritoryArgs,
  type BuildStructureArgs,
  type CameraControlArgs,
  type DiplomacyActionArgs,
  type ExecutePlanArgs,
  type ExecutePlanStep,
  type ExpandBurstArgs,
  type FocusRegionArgs,
  type LaunchSpecialArgs,
  type PanMapArgs,
  type ResetOverviewArgs,
  type SelectSpawnArgs,
  type SetAttackRatioArgs,
  type ToolArgsByName,
  type WaitObserveArgs,
  type ZoomMapArgs,
} from './harness/tool-schemas.js';
export {
  createToolObservation,
  parseActionRequest,
  type CreateToolObservationInput,
  type ParsedActionRequest,
} from './harness/tool-parser.js';
export {
  RateLimiter,
  type RateLimitAcquireResult,
  type RateLimitConsumeResult,
  type RateLimiterOptions,
  type RateLimiterState,
} from './harness/rate-limiter.js';
export {
  ActionExecutor,
  type ActionExecutorOptions,
} from './harness/action-executor.js';
export {
  type BrowserActuator,
  type ClickOptions,
  type DragOptions,
  type KeyHoldOptions,
  type KeyModifier,
  type KeyPressOptions,
  type MouseButton,
  type WheelOptions,
} from './browser/actuator.js';
export {
  McpActuator,
  type McpActuatorOptions,
  type McpConnectOptions,
  type McpToolCallResult,
  type McpToolCaller,
} from './browser/mcp-actuator.js';
export {
  CdpActuator,
  type CdpActuatorOptions,
  type CdpClientLike,
  type CdpConnectOptions,
  type CdpDispatchKeyEventParams,
  type CdpDispatchMouseEventParams,
  type CdpEvaluateResult,
  type CdpLayoutMetrics,
} from './browser/cdp-actuator.js';
export {
  FallbackActuator,
  type FallbackActuatorOptions,
  type FallbackStatus,
  type LatencyBenchmarkResult,
  type TransportLatencyStats,
} from './browser/fallback-actuator.js';
export {
  PUBLIC_HUD_READ_EXPRESSION,
  formatHudHeaderLine,
  parseCompactHudNumber,
  parsePublicHudRaw,
  type PublicHudRaw,
  type PublicHudSnapshot,
} from './browser/hud-reader.js';
export {
  launchNonThrottledBrowser,
  resolveBrowserExecutable,
  type BrowserLaunchOptions,
  type LaunchedBrowser,
} from './browser/chrome-launcher.js';
export {
  ViewportCapture,
  type ScreencastFrameEvent,
  type ScreencastTransportClient,
  type ViewportCaptureConnectOptions,
  type ViewportCaptureOptions,
  type ViewportCaptureStats,
} from './browser/viewport-capture.js';
export {
  CdpLobbyPageAdapter,
  LobbyNavigator,
  type CdpLobbyClientLike,
  type LobbyJoinOptions,
  type LobbyJoinResult,
  type LobbyNavigatorOptions,
  type LobbyPageAdapter,
} from './browser/lobby-navigator.js';
export {
  TelemetryLogger,
  type ActionTelemetryEntry,
  type ActionTelemetryInput,
  type RationaleSample,
  type SessionTelemetryEntry,
  type TelemetryLoggerOptions,
  type TelemetrySummary,
} from './loop/telemetry.js';
export { MatchOrchestrator, type MatchOrchestratorOptions } from './loop/orchestrator.js';
export {
  buildComparisonScorecard,
  computeMatchMetrics,
  computeMatchMetricsFromLines,
  formatScorecardMarkdown,
  type BridgeHealthEvalCounters,
  type EvalComparisonScorecard,
  type EvalMatchMetrics,
  type EvalScorecardRow,
} from './eval/scorecard.js';
export { parseCliRuntimeOptions, parseHostPort, runCli, waitForDurationOrSignal, type CliRuntimeOptions } from './cli.js';
