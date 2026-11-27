import { describe, expect, it } from 'vitest';
import { assertTargetAllowed } from '../../src/config/env.js';
import { ConfigValidationError, FairPlayGuardError } from '../../src/errors/app-error.js';

describe('FairPlayGuard (assertTargetAllowed)', () => {
  it('allows localhost and 127.0.0.1 targets by default', () => {
    expect(() =>
      assertTargetAllowed('http://localhost:9000', {
        allowPublicEnv: false,
        allowPublicCliFlag: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertTargetAllowed('http://127.0.0.1:9000/lobby/abc', {
        allowPublicEnv: false,
        allowPublicCliFlag: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertTargetAllowed('http://[::1]:9000', {
        allowPublicEnv: false,
        allowPublicCliFlag: false,
      }),
    ).not.toThrow();
  });

  it('blocks openfront.io, subdomains, and arbitrary public hosts by default', () => {
    const blockedUrls = [
      'https://openfront.io',
      'https://www.openfront.io/play',
      'https://eu.openfront.io',
      'https://example.com:9000',
    ];

    for (const url of blockedUrls) {
      expect(() =>
        assertTargetAllowed(url, {
          allowPublicEnv: false,
          allowPublicCliFlag: false,
        }),
      ).toThrow(FairPlayGuardError);
    }
  });

  it('still blocks public hosts when only OPENBOT_ALLOW_PUBLIC=true is set', () => {
    expect(() =>
      assertTargetAllowed('https://openfront.io', {
        allowPublicEnv: true,
        allowPublicCliFlag: false,
      }),
    ).toThrow(FairPlayGuardError);
  });

  it('still blocks public hosts when only --allow-public-lobby is set', () => {
    expect(() =>
      assertTargetAllowed('https://openfront.io', {
        allowPublicEnv: false,
        allowPublicCliFlag: true,
      }),
    ).toThrow(FairPlayGuardError);
  });

  it('unlocks public hosts only when both env and CLI flag are explicitly enabled', () => {
    expect(() =>
      assertTargetAllowed('https://openfront.io', {
        allowPublicEnv: true,
        allowPublicCliFlag: true,
      }),
    ).not.toThrow();
  });

  it('throws ConfigValidationError for malformed URLs or unsupported protocols', () => {
    expect(() =>
      assertTargetAllowed('not-a-valid-url', {
        allowPublicEnv: false,
        allowPublicCliFlag: false,
      }),
    ).toThrow(ConfigValidationError);

    expect(() =>
      assertTargetAllowed('file:///C:/temp/index.html', {
        allowPublicEnv: false,
        allowPublicCliFlag: false,
      }),
    ).toThrow(ConfigValidationError);
  });
});
