import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../src/config/env.js';
import { ConfigValidationError, FairPlayGuardError } from '../../src/errors/app-error.js';

describe('EnvConfig (loadConfig & redactConfig)', () => {
  it('loads valid defaults for local development without requiring GEMINI_API_KEY in Phase 1', () => {
    const config = loadConfig({}, []);

    expect(config.geminiLiveModel).toBe('gemini-2.5-flash-native-audio-preview-12-2025');
    expect(config.targetUrl).toBe('http://localhost:9000');
    expect(config.allowPublicEnv).toBe(false);
    expect(config.allowPublicCliFlag).toBe(false);
    expect(config.bridgeHost).toBe('127.0.0.1');
    expect(config.bridgePort).toBe(8765);
    expect(config.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(config.maxApm).toBe(45);
  });

  it('rejects out-of-range ports and APM bounds with ConfigValidationError', () => {
    expect(() => loadConfig({ OPENBOT_BRIDGE_PORT: '70000' }, [])).toThrow(ConfigValidationError);
    expect(() => loadConfig({ OPENBOT_BRIDGE_PORT: '0' }, [])).toThrow(ConfigValidationError);
    expect(() => loadConfig({ OPENBOT_MAX_APM: '0' }, [])).toThrow(ConfigValidationError);
    expect(() => loadConfig({ OPENBOT_MAX_APM: '500' }, [])).toThrow(ConfigValidationError);
  });

  it('rejects public target URLs during loadConfig unless both opt-ins are active', () => {
    expect(() =>
      loadConfig({ OPENBOT_TARGET_URL: 'https://openfront.io' }, []),
    ).toThrow(FairPlayGuardError);

    expect(() =>
      loadConfig(
        { OPENBOT_TARGET_URL: 'https://openfront.io', OPENBOT_ALLOW_PUBLIC: 'true' },
        [],
      ),
    ).toThrow(FairPlayGuardError);

    const unlocked = loadConfig(
      { OPENBOT_TARGET_URL: 'https://openfront.io', OPENBOT_ALLOW_PUBLIC: 'true' },
      ['--allow-public-lobby'],
    );
    expect(unlocked.targetUrl).toBe('https://openfront.io');
    expect(unlocked.allowPublicEnv).toBe(true);
    expect(unlocked.allowPublicCliFlag).toBe(true);
  });

  it('redacts GEMINI_API_KEY when serializing config', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'test-secret-value-123456' }, []);
    const redacted = redactConfig(config);

    expect(redacted.geminiApiKey).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('test-secret-value-123456');

    const emptySecret = redactConfig(loadConfig({}, []));
    expect(emptySecret.geminiApiKey).toBe('[UNSET]');
  });
});
