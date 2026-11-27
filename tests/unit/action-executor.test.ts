import { describe, expect, it, vi } from 'vitest';
import type { BrowserActuator } from '../../src/browser/actuator.js';
import { ActionExecutor } from '../../src/harness/action-executor.js';
import { ActionResponseSchema } from '../../src/harness/contract-loader.js';
import { RateLimiter } from '../../src/harness/rate-limiter.js';

function createMockActuator() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const actuator: BrowserActuator = {
    getViewportRect: vi.fn(() => {
      calls.push({ method: 'getViewportRect', args: [] });
      return Promise.resolve({ left: 0, top: 0, width: 1000, height: 1000 });
    }),
    clickAt: vi.fn((x, y, options) => {
      calls.push({ method: 'clickAt', args: [x, y, options] });
      return Promise.resolve();
    }),
    drag: vi.fn((fx, fy, tx, ty, options) => {
      calls.push({ method: 'drag', args: [fx, fy, tx, ty, options] });
      return Promise.resolve();
    }),
    wheelAt: vi.fn((x, y, dx, dy, options) => {
      calls.push({ method: 'wheelAt', args: [x, y, dx, dy, options] });
      return Promise.resolve();
    }),
    pressKey: vi.fn((key, options) => {
      calls.push({ method: 'pressKey', args: [key, options] });
      return Promise.resolve();
    }),
    holdKey: vi.fn((key, durationMs, options) => {
      calls.push({ method: 'holdKey', args: [key, durationMs, options] });
      return Promise.resolve();
    }),
    clickDomSelector: vi.fn((selector) => {
      calls.push({ method: 'clickDomSelector', args: [selector] });
      return Promise.resolve();
    }),
    fillDomSelector: vi.fn((selector, value) => {
      calls.push({ method: 'fillDomSelector', args: [selector, value] });
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      calls.push({ method: 'close', args: [] });
      return Promise.resolve();
    }),
  };

  return { actuator, calls };
}

describe('ActionExecutor', () => {
  function createExecutor(blockingRateLimit = true) {
    let nowMs = 1_000;
    const { actuator, calls } = createMockActuator();
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 120,
      burstCap: 10,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
      blockingRateLimit,
    });

    return { executor, actuator, calls, sleep };
  }

  const baseEnvelope = {
    type: 'action_request' as const,
    call_id: 'call-1',
    session_id: 'sess-1',
    frame_captured_at_ms: 100,
    model_emitted_at_ms: 120,
  };

  it('executes select_spawn with left click at mapped coordinates', async () => {
    const { executor, calls } = createExecutor();
    const response = await executor.execute({
      ...baseEnvelope,
      tool_name: 'select_spawn',
      arguments: { x: 0.25, y: 0.75, rationale: 'Good coastline' },
    });

    expect(ActionResponseSchema.safeParse(response).success).toBe(true);
    expect(response.status).toBe('success');
    expect(calls).toContainEqual({ method: 'clickAt', args: [250, 750, { button: 'left' }] });
  });

  it('executes attack_territory for both ground and boat modes with optional ratio adjustment', async () => {
    const { executor, calls } = createExecutor();

    const boatRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'call-boat',
      tool_name: 'attack_territory',
      arguments: {
        x: 0.8,
        y: 0.2,
        ratio_pct: 40,
        mode: 'boat',
        rationale: 'Amphibious landing',
      },
    });

    expect(boatRes.status).toBe('success');
    const keyCalls = calls.filter((c) => c.method === 'pressKey').map((c) => c.args[0]);
    expect(keyCalls).toEqual(['KeyY', 'KeyY', 'KeyB']);
    expect(calls).toContainEqual({ method: 'clickAt', args: [800, 200, { button: 'left' }] });
  });

  it('executes set_attack_ratio downward and upward using KeyT / KeyY', async () => {
    const { executor, calls } = createExecutor();

    const res = await executor.execute({
      ...baseEnvelope,
      tool_name: 'set_attack_ratio',
      arguments: { ratio_pct: 1, rationale: 'Minimum probe' },
    });

    expect(res.status).toBe('success');
    const keyCalls = calls.filter((c) => c.method === 'pressKey').map((c) => c.args[0]);
    expect(keyCalls).toEqual(['KeyT', 'KeyT']);
  });

  it('executes build_structure and launch_special using verified Digit1..Digit0 hotkeys', async () => {
    const { executor, calls } = createExecutor();

    await executor.execute({
      ...baseEnvelope,
      call_id: 'build-1',
      tool_name: 'build_structure',
      arguments: { structure: 'sam_launcher', x: 0.5, y: 0.5, rationale: 'Defend capital' },
    });

    await executor.execute({
      ...baseEnvelope,
      call_id: 'nuke-1',
      tool_name: 'launch_special',
      arguments: { unit: 'mirv', x: 0.9, y: 0.9, rationale: 'Endgame' },
    });

    expect(calls).toContainEqual({ method: 'pressKey', args: ['Digit6', undefined] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [500, 500, { button: 'left' }] });
    expect(calls).toContainEqual({ method: 'pressKey', args: ['Digit0', undefined] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [900, 900, { button: 'left' }] });
  });

  it('executes diplomacy_action via hotkey+click or right-click radial for embargo', async () => {
    const { executor, calls } = createExecutor();

    await executor.execute({
      ...baseEnvelope,
      call_id: 'dip-1',
      tool_name: 'diplomacy_action',
      arguments: { action: 'request_alliance', x: 0.4, y: 0.4, rationale: 'Peace' },
    });
    expect(calls).toContainEqual({ method: 'pressKey', args: ['KeyK', undefined] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [400, 400, { button: 'left' }] });

    await executor.execute({
      ...baseEnvelope,
      call_id: 'dip-2',
      tool_name: 'diplomacy_action',
      arguments: { action: 'embargo', x: 0.6, y: 0.6, rationale: 'Cut trade' },
    });
    expect(calls).toContainEqual({ method: 'clickAt', args: [600, 600, { button: 'right' }] });
  });

  it('executes camera_control and wait_observe tools cleanly', async () => {
    const { executor, calls, sleep } = createExecutor();

    const camRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'cam-1',
      tool_name: 'camera_control',
      arguments: {
        pan: 'left',
        pan_ms: 400,
        zoom_steps: 2,
        toggle_coord_grid: true,
        center_camera: true,
        rationale: 'Survey flank',
      },
    });
    expect(camRes.status).toBe('success');
    expect(calls).toContainEqual({ method: 'pressKey', args: ['KeyC', undefined] });
    expect(calls).toContainEqual({ method: 'pressKey', args: ['KeyM', undefined] });
    expect(calls).toContainEqual({ method: 'holdKey', args: ['KeyA', 400, undefined] });
    expect(calls).toContainEqual({ method: 'wheelAt', args: [500, 500, 0, -240, undefined] });

    const waitRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'wait-1',
      tool_name: 'wait_observe',
      arguments: { duration_ms: 1200, rationale: 'Wait for troops' },
    });
    expect(waitRes.status).toBe('success');
    expect(waitRes.scheduling).toBe('WHEN_IDLE');
    expect(sleep).toHaveBeenCalledWith(1200);

    const altCamRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'cam-alt',
      tool_name: 'camera_control',
      arguments: { toggle_alt_view: true, rationale: 'Inspect terrain' },
    });
    expect(altCamRes.status).toBe('success');
    expect(calls).toContainEqual({ method: 'holdKey', args: ['Space', 300, undefined] });

    const noopCamRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'cam-noop',
      tool_name: 'camera_control',
      arguments: { rationale: 'Nothing requested' },
    });
    expect(noopCamRes.status).toBe('warning');
    expect(noopCamRes.scheduling).toBe('WHEN_IDLE');
  });

  it('refreshes stale CoordinateMapper and supports ground attack without ratio change', async () => {
    let nowMs = 1_000;
    const { actuator, calls } = createMockActuator();
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 120,
      burstCap: 10,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
      initialAttackRatioPct: 30,
    });

    expect(executor.getCurrentAttackRatioPct()).toBe(30);
    await executor.execute({
      ...baseEnvelope,
      call_id: 'atk-ground',
      tool_name: 'attack_territory',
      arguments: { x: 0.5, y: 0.5, rationale: 'Push center' },
    });

    // Advance past CoordinateMapper default 5000ms maxAgeMs to trigger stale refresh
    nowMs += 6_000;
    await executor.execute({
      ...baseEnvelope,
      call_id: 'atk-ground-2',
      tool_name: 'attack_territory',
      arguments: { x: 0.2, y: 0.2, mode: 'ground', rationale: 'Push flank' },
    });

    const viewportCalls = calls.filter((c) => c.method === 'getViewportRect');
    expect(viewportCalls).toHaveLength(2);
  });

  it('returns deterministic error observation with recovery when validation, rate limit, or actuator fails', async () => {
    let nowMs = 1_000;
    const { actuator } = createMockActuator();
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 30,
      burstCap: 1,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
      blockingRateLimit: false,
    });

    const invalidRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'bad-1',
      tool_name: 'unknown_tool',
      arguments: {},
    });
    expect(invalidRes.status).toBe('error');
    expect(invalidRes.call_id).toBe('bad-1');
    expect(invalidRes.scheduling).toBe('INTERRUPT');
    expect(invalidRes.recovery?.root_cause).toContain('ToolValidationError');

    const malformedRes = await executor.execute('{not-json');
    expect(malformedRes.status).toBe('error');
    expect(malformedRes.call_id).toBe('unknown');

    await executor.execute({
      ...baseEnvelope,
      call_id: 'ok-1',
      tool_name: 'wait_observe',
      arguments: { duration_ms: 500, rationale: 'consume token' },
    });
    const rateLimitedRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'rl-1',
      tool_name: 'wait_observe',
      arguments: { duration_ms: 500, rationale: 'should be rate limited' },
    });
    expect(rateLimitedRes.status).toBe('error');
    expect(rateLimitedRes.recovery?.root_cause).toContain('Rate limit');

    // Recover after advancing clock and test actuator failure
    nowMs += 3_000;
    (actuator.clickAt as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error('Browser disconnected')),
    );
    const actuatorFailRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'act-fail',
      tool_name: 'select_spawn',
      arguments: { x: 0.5, y: 0.5, rationale: 'spawn' },
    });
    expect(actuatorFailRes.status).toBe('error');
    expect(actuatorFailRes.recovery?.root_cause).toContain('Browser disconnected');
  });

  it('executes zoom_map via discrete wheel steps and pan_map via WASD keys with zero accidental clicks', async () => {
    const { executor, calls } = createExecutor(true);

    const zoomIn = await executor.execute({
      ...baseEnvelope,
      call_id: 'zoom-1',
      tool_name: 'zoom_map',
      arguments: { direction: 'in', steps: 3, x: 0.4, y: 0.6, rationale: 'Zoom onto coast' },
    });
    expect(zoomIn.status).toBe('success');
    expect(ActionResponseSchema.safeParse(zoomIn).success).toBe(true);

    const wheelCalls = calls.filter((c) => c.method === 'wheelAt');
    expect(wheelCalls).toEqual([
      { method: 'wheelAt', args: [400, 600, 0, -150, undefined] },
      { method: 'wheelAt', args: [400, 600, 0, -150, undefined] },
      { method: 'wheelAt', args: [400, 600, 0, -150, undefined] },
    ]);

    const panCardinal = await executor.execute({
      ...baseEnvelope,
      call_id: 'pan-1',
      tool_name: 'pan_map',
      arguments: { direction: 'right', duration_ms: 400, rationale: 'Scan eastern front' },
    });
    expect(panCardinal.status).toBe('success');
    expect(calls.some((c) => c.method === 'holdKey' && c.args[0] === 'KeyD' && c.args[1] === 400)).toBe(
      true,
    );

    const panDiag = await executor.execute({
      ...baseEnvelope,
      call_id: 'pan-2',
      tool_name: 'pan_map',
      arguments: {
        direction: 'up_left',
        duration_ms: 500,
        center_camera: true,
        rationale: 'Recenter and scan northwest',
      },
    });
    expect(panDiag.status).toBe('success');
    expect(calls.some((c) => c.method === 'pressKey' && c.args[0] === 'KeyC')).toBe(true);
    expect(calls.filter((c) => c.method === 'clickAt')).toHaveLength(0);
  });

  it('verifies build_structure & launch_special via HUD gold delta + Escape ghost cleanup', async () => {
    let nowMs = 1_000;
    const { actuator, calls } = createMockActuator();
    const hudSequence = [
      { type: 'hud_snapshot' as const, timestamp_ms: 1000, panel_visible: true, game_over: false, gold: 250_000 },
      { type: 'hud_snapshot' as const, timestamp_ms: 1400, panel_visible: true, game_over: false, gold: 125_000 },
      { type: 'hud_snapshot' as const, timestamp_ms: 2000, panel_visible: true, game_over: false, gold: 150_000 },
      { type: 'hud_snapshot' as const, timestamp_ms: 2400, panel_visible: true, game_over: false, gold: 150_000 },
    ];
    let hudIdx = 0;
    actuator.readPublicHud = vi.fn(() => {
      const next = hudSequence[Math.min(hudIdx, hudSequence.length - 1)]!;
      hudIdx += 1;
      calls.push({ method: 'readPublicHud', args: [next.gold] });
      return Promise.resolve(next);
    });

    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 120,
      burstCap: 10,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
      buildVerifyDelayMs: 400,
    });

    const okBuild = await executor.execute({
      ...baseEnvelope,
      call_id: 'build-ok',
      tool_name: 'build_structure',
      arguments: { structure: 'warship', x: 0.3, y: 0.7, rationale: 'Escort sea lane' },
    });
    expect(okBuild.status).toBe('success');
    expect(okBuild.artifacts['verified']).toBe(true);
    expect(okBuild.artifacts['goldDelta']).toBe(-125_000);
    expect(calls.filter((c) => c.method === 'pressKey' && c.args[0] === 'Escape')).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(400);

    const failedBuild = await executor.execute({
      ...baseEnvelope,
      call_id: 'build-fail',
      tool_name: 'build_structure',
      arguments: { structure: 'city', x: 0.5, y: 0.5, rationale: 'Build city' },
    });
    expect(failedBuild.status).toBe('failed');
    expect(failedBuild.summary).toContain('insufficient_gold_or_invalid_tile');
    expect(failedBuild.artifacts['verified']).toBe(false);
    expect(failedBuild.artifacts['reason']).toBe('insufficient_gold_or_invalid_tile');
    expect(failedBuild.scheduling).toBe('WHEN_IDLE');
  });

  it('executes focus_region, reset_overview, and execute_plan batch with abort-on-error', async () => {
    const { executor, calls, sleep } = createExecutor(true);

    const focusRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'focus-1',
      tool_name: 'focus_region',
      arguments: { x: 0.2, y: 0.8, zoom_steps: 2, rationale: 'Zoom onto coast' },
    });
    expect(focusRes.status).toBe('success');
    expect(executor.isCameraZoomed()).toBe(true);
    expect(calls.filter((c) => c.method === 'wheelAt')).toEqual([
      { method: 'wheelAt', args: [200, 800, 0, -300, undefined] },
    ]);
    expect(calls.filter((c) => c.method === 'clickAt')).toHaveLength(0);

    const resetRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'reset-1',
      tool_name: 'reset_overview',
      arguments: { zoom_out_steps: 3, rationale: 'Regain map view' },
    });
    expect(resetRes.status).toBe('success');
    expect(executor.isCameraZoomed()).toBe(false);
    expect(calls).toContainEqual({ method: 'pressKey', args: ['KeyC', undefined] });
    expect(calls.filter((c) => c.method === 'wheelAt' && c.args[3] === 450)).toHaveLength(1);

    const planRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'plan-1',
      tool_name: 'execute_plan',
      arguments: {
        step_delay_ms: 180,
        rationale: 'Double front push',
        actions: [
          { tool_name: 'set_attack_ratio', arguments: { ratio_pct: 30, rationale: 'Set 30%' } },
          { tool_name: 'attack_territory', arguments: { x: 0.4, y: 0.4, rationale: 'North push' } },
          { tool_name: 'attack_territory', arguments: { x: 0.6, y: 0.4, rationale: 'East push' } },
        ],
      },
    });
    expect(planRes.status).toBe('success');
    expect(planRes.artifacts['executedSteps']).toBe(3);
    expect(planRes.artifacts['aborted']).toBe(false);
    expect(sleep).toHaveBeenCalledWith(180);

    // Abort immediately when a sub-step fails
    (calls.length = 0);
    const actuatorMock = executor as unknown as { actuator: BrowserActuator };
    (actuatorMock.actuator.clickAt as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error('Target detached')),
    );
    const abortedPlan = await executor.execute({
      ...baseEnvelope,
      call_id: 'plan-abort',
      tool_name: 'execute_plan',
      arguments: {
        rationale: 'Should abort on first click failure',
        actions: [
          { tool_name: 'attack_territory', arguments: { x: 0.4, y: 0.4, rationale: 'Fail click' } },
          { tool_name: 'attack_territory', arguments: { x: 0.6, y: 0.4, rationale: 'Should not run' } },
        ],
      },
    });
    expect(abortedPlan.status).toBe('error');
    expect(abortedPlan.artifacts['executedSteps']).toBe(1);
    expect(abortedPlan.artifacts['aborted']).toBe(true);
  });

  it('skips unaffordable builds via pre-click HUD guard and continues execute_plan on soft build failure', async () => {
    let nowMs = 1_000;
    const { actuator, calls } = createMockActuator();
    actuator.readPublicHud = vi.fn(() =>
      Promise.resolve({
        type: 'hud_snapshot' as const,
        timestamp_ms: nowMs,
        panel_visible: true,
        game_over: false,
        gold: 40_000,
      }),
    );
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 120,
      burstCap: 10,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
      buildVerifyDelayMs: 400,
    });

    // Standalone unaffordable build skips click + hotkey + 400ms wait completely
    const skippedBuild = await executor.execute({
      ...baseEnvelope,
      call_id: 'build-unaffordable',
      tool_name: 'build_structure',
      arguments: { structure: 'city', x: 0.5, y: 0.5, rationale: 'Try city too early' },
    });
    expect(skippedBuild.status).toBe('failed');
    expect(skippedBuild.artifacts['skippedBeforeClick']).toBe(true);
    expect(skippedBuild.artifacts['reason']).toBe('insufficient_gold');
    expect(skippedBuild.artifacts['requiredGold']).toBe(125_000);
    expect(calls.filter((c) => c.method === 'pressKey')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'clickAt')).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalledWith(400);

    // execute_plan continues remaining attack/camera steps after soft build_structure failure
    calls.length = 0;
    const mixedPlan = await executor.execute({
      ...baseEnvelope,
      call_id: 'plan-soft-continue',
      tool_name: 'execute_plan',
      arguments: {
        step_delay_ms: 180,
        rationale: 'Build or expand',
        actions: [
          { tool_name: 'build_structure', arguments: { structure: 'city', x: 0.5, y: 0.5, rationale: 'Try city' } },
          { tool_name: 'attack_territory', arguments: { x: 0.4, y: 0.4, rationale: 'North push' } },
          { tool_name: 'focus_region', arguments: { x: 0.6, y: 0.6, zoom_steps: 2, rationale: 'Zoom coast' } },
        ],
      },
    });
    expect(mixedPlan.status).toBe('warning');
    expect(mixedPlan.artifacts['aborted']).toBe(false);
    expect(mixedPlan.artifacts['executedSteps']).toBe(3);
    const stepResults = mixedPlan.artifacts['stepResults'] as Array<{ toolName: string; status: string }>;
    expect(stepResults.map((s) => `${s.toolName}:${s.status}`)).toEqual([
      'build_structure:failed',
      'attack_territory:success',
      'focus_region:success',
    ]);
    expect(calls).toContainEqual({ method: 'clickAt', args: [400, 400, { button: 'left' }] });
    expect(calls.filter((c) => c.method === 'wheelAt')).toHaveLength(1);
  });

  it('executes expand_burst, fast 4-step execute_plan <1200ms, and auto camera hygiene reset', async () => {
    let nowMs = 1_000;
    const { actuator, calls } = createMockActuator();
    let mockGold = 300_000;
    actuator.readPublicHud = vi.fn(() => {
      const currentGold = mockGold;
      mockGold -= 125_000;
      return Promise.resolve({
        type: 'hud_snapshot' as const,
        timestamp_ms: nowMs,
        panel_visible: true,
        game_over: false,
        gold: Math.max(0, currentGold),
      });
    });
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const rateLimiter = new RateLimiter({
      maxApm: 120,
      burstCap: 10,
      minJitterMs: 10,
      maxJitterMs: 10,
      now: () => nowMs,
      sleep,
      rng: () => 0.5,
    });
    const executor = new ActionExecutor({
      actuator,
      rateLimiter,
      now: () => nowMs,
      sleep,
    });

    const burstStart = nowMs;
    const burstRes = await executor.execute({
      ...baseEnvelope,
      call_id: 'burst-1',
      tool_name: 'expand_burst',
      arguments: { x: 0.5, y: 0.5, spread: 0.08, count: 4, ratio_pct: 40, rationale: 'Sweep border' },
    });
    expect(burstRes.status).toBe('success');
    expect(burstRes.artifacts['executedSteps']).toBe(4);
    expect(calls.filter((c) => c.method === 'clickAt')).toHaveLength(4);
    expect(calls).toContainEqual({ method: 'clickAt', args: [580, 500, { button: 'left' }] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [420, 500, { button: 'left' }] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [500, 420, { button: 'left' }] });
    expect(calls).toContainEqual({ method: 'clickAt', args: [500, 580, { button: 'left' }] });
    expect(nowMs - burstStart).toBeLessThan(1_200);

    // focus_region + build_structure auto-appends reset_overview and keeps 4-step batch < 1200ms
    calls.length = 0;
    const focusBuildStart = nowMs;
    const focusBuildPlan = await executor.execute({
      ...baseEnvelope,
      call_id: 'plan-focus-build',
      tool_name: 'execute_plan',
      arguments: {
        rationale: 'Focus and build city',
        actions: [
          { tool_name: 'focus_region', arguments: { x: 0.5, y: 0.3, zoom_steps: 3, rationale: 'Zoom' } },
          { tool_name: 'build_structure', arguments: { structure: 'city', x: 0.5, y: 0.3, rationale: 'City' } },
        ],
      },
    });
    const fbSteps = focusBuildPlan.artifacts['stepResults'] as Array<{ toolName: string; status: string }>;
    expect(fbSteps.map((s) => s.toolName)).toEqual([
      'focus_region',
      'build_structure',
      'reset_overview',
    ]);
    expect(executor.isCameraZoomed()).toBe(false);
    expect(nowMs - focusBuildStart).toBeLessThan(1_200);

    // 2 consecutive zoomed turns without reset_overview trigger auto-reset on turn 2
    await executor.execute({
      ...baseEnvelope,
      call_id: 'zoom-turn-1',
      tool_name: 'execute_plan',
      arguments: {
        rationale: 'Zoom turn 1',
        actions: [
          { tool_name: 'focus_region', arguments: { x: 0.4, y: 0.4, zoom_steps: 2, rationale: 'Zoom' } },
        ],
      },
    });
    expect(executor.isCameraZoomed()).toBe(true);
    expect(executor.getConsecutiveZoomedTurns()).toBe(1);

    const turn2 = await executor.execute({
      ...baseEnvelope,
      call_id: 'zoom-turn-2',
      tool_name: 'execute_plan',
      arguments: {
        rationale: 'Zoom turn 2 attacks',
        actions: [
          { tool_name: 'attack_territory', arguments: { x: 0.45, y: 0.45, rationale: 'Push' } },
        ],
      },
    });
    const t2Steps = turn2.artifacts['stepResults'] as Array<{ toolName: string }>;
    expect(t2Steps.map((s) => s.toolName)).toEqual(['attack_territory', 'reset_overview']);
    expect(executor.isCameraZoomed()).toBe(false);
    expect(executor.getConsecutiveZoomedTurns()).toBe(0);

    // Mid-batch reset_overview clears cameraZoomed and must NOT append a duplicate reset_overview
    const midResetPlan = await executor.execute({
      ...baseEnvelope,
      call_id: 'plan-mid-reset',
      tool_name: 'execute_plan',
      arguments: {
        rationale: 'Focus, build, explicit mid-reset, attack',
        actions: [
          { tool_name: 'focus_region', arguments: { x: 0.5, y: 0.3, zoom_steps: 2, rationale: 'Zoom' } },
          { tool_name: 'build_structure', arguments: { structure: 'defense_post', x: 0.5, y: 0.3, rationale: 'Fort' } },
          { tool_name: 'reset_overview', arguments: { zoom_out_steps: 6, rationale: 'Reset' } },
          { tool_name: 'attack_territory', arguments: { x: 0.6, y: 0.4, rationale: 'Expand' } },
        ],
      },
    });
    const midSteps = midResetPlan.artifacts['stepResults'] as Array<{ toolName: string }>;
    expect(midSteps.map((s) => s.toolName)).toEqual([
      'focus_region',
      'build_structure',
      'reset_overview',
      'attack_territory',
    ]);
    expect(executor.isCameraZoomed()).toBe(false);
  });
});
