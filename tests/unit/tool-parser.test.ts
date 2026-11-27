import { describe, expect, it } from 'vitest';
import { ToolValidationError } from '../../src/errors/app-error.js';
import { ActionResponseSchema } from '../../src/harness/contract-loader.js';
import { createToolObservation, parseActionRequest } from '../../src/harness/tool-parser.js';

describe('ToolParser & ToolSchemas', () => {
  const baseEnvelope = {
    type: 'action_request' as const,
    call_id: 'call-123',
    session_id: 'session-abc',
    frame_captured_at_ms: 1000,
    model_emitted_at_ms: 1080,
  };

  it('parses valid payloads for all 8 OpenFront gameplay tools', () => {
    const validRequests = [
      {
        ...baseEnvelope,
        tool_name: 'select_spawn',
        arguments: { x: 0.4, y: 0.6, rationale: 'Rich coast' },
      },
      {
        ...baseEnvelope,
        tool_name: 'attack_territory',
        arguments: { x: 0.7, y: 0.3, ratio_pct: 40, mode: 'boat', rationale: 'Naval flank' },
      },
      {
        ...baseEnvelope,
        tool_name: 'set_attack_ratio',
        arguments: { ratio_pct: 55, rationale: 'Conserve troops' },
      },
      {
        ...baseEnvelope,
        tool_name: 'build_structure',
        arguments: { structure: 'sam_launcher', x: 0.2, y: 0.8, rationale: 'Anti-nuke' },
      },
      {
        ...baseEnvelope,
        tool_name: 'launch_special',
        arguments: { unit: 'mirv', x: 0.9, y: 0.1, rationale: 'Decisive strike' },
      },
      {
        ...baseEnvelope,
        tool_name: 'diplomacy_action',
        arguments: { action: 'request_alliance', x: 0.3, y: 0.4, rationale: 'Secure flank' },
      },
      {
        ...baseEnvelope,
        tool_name: 'camera_control',
        arguments: { pan: 'up', pan_ms: 250, zoom_steps: -2, rationale: 'Inspect north' },
      },
      {
        ...baseEnvelope,
        tool_name: 'zoom_map',
        arguments: { direction: 'in', steps: 4, x: 0.5, y: 0.5, rationale: 'Inspect border' },
      },
      {
        ...baseEnvelope,
        tool_name: 'pan_map',
        arguments: { direction: 'up_right', duration_ms: 400, rationale: 'Scan northeast front' },
      },
      {
        ...baseEnvelope,
        tool_name: 'wait_observe',
        arguments: { duration_ms: 1500, rationale: 'Accumulate gold' },
      },
      {
        ...baseEnvelope,
        tool_name: 'focus_region',
        arguments: { x: 0.25, y: 0.75, zoom_steps: 3, rationale: 'Zoom to coast' },
      },
      {
        ...baseEnvelope,
        tool_name: 'reset_overview',
        arguments: { zoom_out_steps: 8, rationale: 'Reassess full map' },
      },
      {
        ...baseEnvelope,
        tool_name: 'execute_plan',
        arguments: {
          step_delay_ms: 180,
          rationale: 'Expand double front',
          actions: [
            {
              tool_name: 'attack_territory',
              arguments: { x: 0.4, y: 0.4, rationale: 'North push' },
            },
            {
              tool_name: 'build_structure',
              arguments: { structure: 'warship', x: 0.2, y: 0.8, rationale: 'Escort sea' },
            },
          ],
        },
      },
      {
        ...baseEnvelope,
        tool_name: 'expand_burst',
        arguments: { x: 0.5, y: 0.5, spread: 0.06, count: 4, ratio_pct: 35, rationale: 'Fast grab' },
      },
    ];

    for (const req of validRequests) {
      const parsed = parseActionRequest(req);
      expect(parsed.call_id).toBe('call-123');
      expect(parsed.tool_name).toBe(req.tool_name);
    }
  });

  it('parses valid JSON string payloads and rejects malformed JSON', () => {
    const jsonPayload = JSON.stringify({
      ...baseEnvelope,
      tool_name: 'wait_observe',
      arguments: { duration_ms: 1000, rationale: 'Hold position' },
    });
    const parsed = parseActionRequest(jsonPayload);
    expect(parsed.tool_name).toBe('wait_observe');

    expect(() => parseActionRequest('{not-valid-json')).toThrow(ToolValidationError);
  });

  it('rejects unknown tools, out-of-range parameters, and extra fields with ToolValidationError', () => {
    expect(() =>
      parseActionRequest({
        ...baseEnvelope,
        tool_name: 'cheat_win',
        arguments: {},
      }),
    ).toThrow(ToolValidationError);

    expect(() =>
      parseActionRequest({
        ...baseEnvelope,
        tool_name: 'attack_territory',
        arguments: { x: 1.5, y: 0.2, rationale: 'Invalid x' },
      }),
    ).toThrow(ToolValidationError);

    expect(() =>
      parseActionRequest({
        ...baseEnvelope,
        tool_name: 'set_attack_ratio',
        arguments: { ratio_pct: 50.5, rationale: 'Must be integer' },
      }),
    ).toThrow(ToolValidationError);

    expect(() =>
      parseActionRequest({
        ...baseEnvelope,
        tool_name: 'wait_observe',
        arguments: { duration_ms: 100, rationale: 'Too short (<500ms)' },
      }),
    ).toThrow(ToolValidationError);

    expect(() =>
      parseActionRequest({
        ...baseEnvelope,
        tool_name: 'select_spawn',
        arguments: { x: 0.5, y: 0.5, rationale: 'ok', extraField: true },
      }),
    ).toThrow(ToolValidationError);
  });

  it('builds deterministic observation envelopes with recovery contract on error', () => {
    const successObs = createToolObservation({
      callId: 'call-1',
      status: 'success',
      summary: 'Built city at (400, 300)',
      nextActions: ['wait_observe'],
      artifacts: { structure: 'city' },
      latencyMs: 14,
    });
    expect(ActionResponseSchema.safeParse(successObs).success).toBe(true);
    expect(successObs.scheduling).toBe('SILENT');
    expect(successObs.recovery).toBeUndefined();

    const errorObs = createToolObservation({
      callId: 'call-2',
      status: 'error',
      summary: 'Viewport rect missing',
      nextActions: ['wait_observe'],
      artifacts: {},
      latencyMs: 5,
    });
    expect(ActionResponseSchema.safeParse(errorObs).success).toBe(true);
    expect(errorObs.scheduling).toBe('INTERRUPT');
    expect(errorObs.recovery).toBeDefined();
    expect(errorObs.recovery?.root_cause.length).toBeGreaterThan(0);
    expect(errorObs.recovery?.safe_retry.length).toBeGreaterThan(0);
    expect(errorObs.recovery?.stop_condition.length).toBeGreaterThan(0);
  });
});
