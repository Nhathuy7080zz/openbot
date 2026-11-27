import { z } from 'zod';
import { ConfigValidationError, FairPlayGuardError } from '../errors/app-error.js';

const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_TARGET_URL = 'http://localhost:9000';
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 8765;
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_MAX_APM = 45;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_APM = 1;
const MAX_APM = 180;
const PUBLIC_CLI_FLAG = '--allow-public-lobby';
const REMOTE_HOST_CLI_FLAG = '--allow-remote-host';

const LOOPBACK_HOSTS = new Set<string>(['localhost', '127.0.0.1', '[::1]', '::1']);
const ALLOWED_PROTOCOLS = new Set<string>(['http:', 'https:']);

const BooleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((val) => val === 'true');

const RawEnvSchema = z.object({
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_LIVE_MODEL: z.string().trim().min(1).default(DEFAULT_GEMINI_LIVE_MODEL),
  OPENBOT_TARGET_URL: z.string().trim().min(1).default(DEFAULT_TARGET_URL),
  OPENBOT_ALLOW_PUBLIC: BooleanStringSchema,
  OPENBOT_BRIDGE_HOST: z.string().trim().min(1).default(DEFAULT_BRIDGE_HOST),
  OPENBOT_BRIDGE_PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT).default(DEFAULT_BRIDGE_PORT),
  OPENBOT_CDP_URL: z.string().trim().min(1).default(DEFAULT_CDP_URL),
  OPENBOT_MAX_APM: z.coerce.number().int().min(MIN_APM).max(MAX_APM).default(DEFAULT_MAX_APM),
  OPENBOT_DEBUG_FRAME_PATH: z.string().trim().optional(),
});

export interface OpenBotConfig {
  readonly geminiApiKey: string;
  readonly geminiLiveModel: string;
  readonly targetUrl: string;
  readonly lobbyUrl?: string;
  readonly debugFramePath?: string;
  readonly allowPublicEnv: boolean;
  readonly allowPublicCliFlag: boolean;
  readonly allowRemoteHostCliFlag: boolean;
  readonly bridgeHost: string;
  readonly bridgePort: number;
  readonly cdpUrl: string;
  readonly maxApm: number;
}

export interface RedactedOpenBotConfig extends Omit<OpenBotConfig, 'geminiApiKey'> {
  readonly geminiApiKey: '[REDACTED]' | '[UNSET]';
}

export interface TargetGuardOptions {
  readonly allowPublicEnv: boolean;
  readonly allowPublicCliFlag: boolean;
  readonly allowRemoteHostCliFlag?: boolean;
}

function readCliOptionValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ConfigValidationError(`Missing value for CLI flag ${flag}`);
      }
      return next;
    }
    if (arg !== undefined && arg.startsWith(`${flag}=`)) {
      const val = arg.slice(flag.length + 1);
      if (val.length === 0) {
        throw new ConfigValidationError(`Empty value for CLI flag ${flag}`);
      }
      return val;
    }
  }
  return undefined;
}

function parseValidatedUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigValidationError(`Invalid ${label}: "${rawUrl}"`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ConfigValidationError(
      `Unsupported protocol "${parsed.protocol}" for ${label}; expected http: or https:`,
    );
  }

  return parsed;
}

/**
 * Enforces that OpenBot only targets loopback hosts unless explicit opt-in flags are provided.
 * Requires OPENBOT_ALLOW_PUBLIC=true + --allow-public-lobby (or --allow-remote-host).
 */
export function assertTargetAllowed(targetUrl: string, options: TargetGuardOptions): URL {
  const parsed = parseValidatedUrl(targetUrl, 'OPENBOT_TARGET_URL');
  const hostname = parsed.hostname.toLowerCase();

  if (LOOPBACK_HOSTS.has(hostname)) {
    return parsed;
  }

  const cliRemoteAllowed = options.allowPublicCliFlag || options.allowRemoteHostCliFlag === true;
  if (!options.allowPublicEnv || !cliRemoteAllowed) {
    throw new FairPlayGuardError(
      targetUrl,
      'Non-loopback targets require OPENBOT_ALLOW_PUBLIC=true and --allow-public-lobby or --allow-remote-host.',
    );
  }

  return parsed;
}

/**
 * Parses and validates runtime configuration from environment variables and CLI arguments.
 */
export function loadConfig(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
): OpenBotConfig {
  const parsedResult = RawEnvSchema.safeParse(rawEnv);
  if (!parsedResult.success) {
    throw new ConfigValidationError('Environment configuration validation failed', parsedResult.error.issues);
  }

  const parsedEnv = parsedResult.data;
  const allowPublicCliFlag = argv.includes(PUBLIC_CLI_FLAG);
  const allowRemoteHostCliFlag = argv.includes(REMOTE_HOST_CLI_FLAG);
  const cliLobbyUrl = readCliOptionValue(argv, '--lobby-url');
  const cliCdpUrl = readCliOptionValue(argv, '--cdp-url');
  const cliDebugFrame = readCliOptionValue(argv, '--debug-frame');

  const effectiveTargetUrl = cliLobbyUrl ?? parsedEnv.OPENBOT_TARGET_URL;
  const effectiveCdpUrl = cliCdpUrl ?? parsedEnv.OPENBOT_CDP_URL;
  const effectiveDebugFrame =
    cliDebugFrame ??
    (parsedEnv.OPENBOT_DEBUG_FRAME_PATH && parsedEnv.OPENBOT_DEBUG_FRAME_PATH.length > 0
      ? parsedEnv.OPENBOT_DEBUG_FRAME_PATH
      : undefined);

  assertTargetAllowed(effectiveTargetUrl, {
    allowPublicEnv: parsedEnv.OPENBOT_ALLOW_PUBLIC,
    allowPublicCliFlag,
    allowRemoteHostCliFlag,
  });

  parseValidatedUrl(effectiveCdpUrl, 'OPENBOT_CDP_URL');

  const baseConfig: OpenBotConfig = {
    geminiApiKey: parsedEnv.GEMINI_API_KEY,
    geminiLiveModel: parsedEnv.GEMINI_LIVE_MODEL,
    targetUrl: effectiveTargetUrl,
    allowPublicEnv: parsedEnv.OPENBOT_ALLOW_PUBLIC,
    allowPublicCliFlag,
    allowRemoteHostCliFlag,
    bridgeHost: parsedEnv.OPENBOT_BRIDGE_HOST,
    bridgePort: parsedEnv.OPENBOT_BRIDGE_PORT,
    cdpUrl: effectiveCdpUrl,
    maxApm: parsedEnv.OPENBOT_MAX_APM,
  };

  return {
    ...baseConfig,
    ...(cliLobbyUrl !== undefined ? { lobbyUrl: cliLobbyUrl } : {}),
    ...(effectiveDebugFrame !== undefined ? { debugFramePath: effectiveDebugFrame } : {}),
  };
}

/**
 * Returns a log-safe copy of configuration with secrets masked.
 */
export function redactConfig(config: OpenBotConfig): RedactedOpenBotConfig {
  return {
    ...config,
    geminiApiKey: config.geminiApiKey.length > 0 ? '[REDACTED]' : '[UNSET]',
  };
}
