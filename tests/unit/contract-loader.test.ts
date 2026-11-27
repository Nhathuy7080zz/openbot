import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigValidationError } from '../../src/errors/app-error.js';
import {
  ACTION_PROTOCOL,
  ActionRequestSchema,
  ActionResponseSchema,
  PingPongSchema,
  SessionStatusSchema,
  TOOL_NAMES,
  loadActionProtocol,
} from '../../src/harness/contract-loader.js';

describe('ContractLoader', () => {
  it('loads and validates contracts/action-protocol.json with exact 14 NON_BLOCKING tools', () => {
    expect(ACTION_PROTOCOL.version).toBe('2.1.0');
    expect(ACTION_PROTOCOL.coordinate_space.min).toBe(0);
    expect(ACTION_PROTOCOL.coordinate_space.max).toBe(1);
    expect(ACTION_PROTOCOL.coordinate_space.origin).toBe('top_left');
    expect(ACTION_PROTOCOL.ipc.host).toBe('127.0.0.1');
    expect(ACTION_PROTOCOL.ipc.default_port).toBe(8765);

    expect(TOOL_NAMES).toEqual([
      'select_spawn',
      'attack_territory',
      'set_attack_ratio',
      'build_structure',
      'launch_special',
      'diplomacy_action',
      'camera_control',
      'zoom_map',
      'pan_map',
      'wait_observe',
      'focus_region',
      'reset_overview',
      'execute_plan',
      'expand_burst',
    ]);

    expect(ACTION_PROTOCOL.gemini_function_declarations).toHaveLength(14);
    for (const decl of ACTION_PROTOCOL.gemini_function_declarations) {
      expect(decl.behavior).toBe('NON_BLOCKING');
      expect(TOOL_NAMES).toContain(decl.name);
    }

    const buildDecl = ACTION_PROTOCOL.gemini_function_declarations.find(
      (d) => d.name === 'build_structure',
    );
    const structureEnum = (
      buildDecl?.parameters.properties['structure'] as { enum?: readonly string[] } | undefined
    )?.enum;
    expect(structureEnum).toEqual([
      'city',
      'factory',
      'port',
      'defense_post',
      'missile_silo',
      'sam_launcher',
      'warship',
      'atom_bomb',
      'hydrogen_bomb',
      'mirv',
    ]);
  });

  it('validates IPC action_request and action_response schemas', () => {
    const validRequest = {
      type: 'action_request',
      call_id: 'call-1',
      session_id: 'sess-1',
      tool_name: 'select_spawn',
      arguments: { x: 0.5, y: 0.5, rationale: 'central' },
      frame_captured_at_ms: 1000,
      model_emitted_at_ms: 1050,
    };
    expect(ActionRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(
      ActionRequestSchema.safeParse({ ...validRequest, call_id: '' }).success,
    ).toBe(false);

    const validResponse = {
      type: 'action_response',
      call_id: 'call-1',
      status: 'success',
      summary: 'Spawn selected',
      next_actions: ['wait_observe'],
      artifacts: { px: 640, py: 360 },
      latency_ms: 12,
      scheduling: 'SILENT',
    };
    expect(ActionResponseSchema.safeParse(validResponse).success).toBe(true);

    const validErrorResponse = {
      ...validResponse,
      status: 'error',
      scheduling: 'INTERRUPT',
      recovery: {
        root_cause: 'Invalid coords',
        safe_retry: 'Clamp x and y to [0..1]',
        stop_condition: 'Stop after 2 failed retries',
      },
    };
    expect(ActionResponseSchema.safeParse({ ...validResponse, status: 'failed' }).success).toBe(
      true,
    );
    expect(ActionResponseSchema.safeParse(validErrorResponse).success).toBe(true);
    expect(
      ActionResponseSchema.safeParse({ ...validResponse, status: 'unknown' }).success,
    ).toBe(false);
  });

  it('validates IPC session_status and ping_pong schemas', () => {
    expect(
      SessionStatusSchema.safeParse({
        type: 'session_status',
        session_id: 'sess-1',
        state: 'connected',
        resumption_handle_present: true,
        timestamp_ms: 12345,
      }).success,
    ).toBe(true);

    expect(
      SessionStatusSchema.safeParse({
        type: 'session_status',
        session_id: 'sess-1',
        state: 'invalid_state',
        resumption_handle_present: false,
        timestamp_ms: 12345,
      }).success,
    ).toBe(false);

    expect(
      PingPongSchema.safeParse({ type: 'ping', timestamp_ms: 100 }).success,
    ).toBe(true);
    expect(
      PingPongSchema.safeParse({ type: 'pong', timestamp_ms: 100 }).success,
    ).toBe(true);
    expect(
      PingPongSchema.safeParse({ type: 'noop', timestamp_ms: 100 }).success,
    ).toBe(false);
  });

  it('throws ConfigValidationError when contract file is missing or malformed', () => {
    expect(() => loadActionProtocol('C:/nonexistent/path/action-protocol.json')).toThrow(
      ConfigValidationError,
    );

    const tempDir = mkdtempSync(join(tmpdir(), 'openbot-contract-'));
    const badPath = join(tempDir, 'bad.json');
    const invalidJsonPath = join(tempDir, 'invalid-syntax.json');
    const missingToolPath = join(tempDir, 'missing-tool.json');
    try {
      writeFileSync(badPath, JSON.stringify({ version: '1.0.0' }), 'utf8');
      expect(() => loadActionProtocol(badPath)).toThrow(ConfigValidationError);

      writeFileSync(invalidJsonPath, '{broken json', 'utf8');
      expect(() => loadActionProtocol(invalidJsonPath)).toThrow(ConfigValidationError);

      const duplicateDecl = {
        ...ACTION_PROTOCOL,
        gemini_function_declarations: Array.from(
          { length: 8 },
          () => ACTION_PROTOCOL.gemini_function_declarations[0],
        ),
      };
      writeFileSync(missingToolPath, JSON.stringify(duplicateDecl), 'utf8');
      expect(() => loadActionProtocol(missingToolPath)).toThrow(ConfigValidationError);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
