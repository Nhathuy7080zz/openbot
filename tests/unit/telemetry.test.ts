import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TelemetryLogger } from '../../src/loop/telemetry.js';

describe('TelemetryLogger', () => {
  it('writes JSONL action & session records and computes p50/p95 latency summaries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-telemetry-'));
    const logPath = path.join(tmpDir, 'match.jsonl');
    const logger = new TelemetryLogger({ logFilePath: logPath });

    logger.logAction({
      callId: 'c1',
      sessionId: 's1',
      toolName: 'select_spawn',
      rationale: 'Center open coast',
      status: 'success',
      frameCapturedAtMs: 1000,
      modelEmittedAtMs: 1120,
      actionCompletedAtMs: 1200,
      scheduling: 'SILENT',
    });

    logger.logAction({
      callId: 'c2',
      sessionId: 's1',
      toolName: 'attack_territory',
      rationale: 'Expand north border',
      status: 'success',
      frameCapturedAtMs: 2000,
      modelEmittedAtMs: 2250,
      actionCompletedAtMs: 2350,
      scheduling: 'SILENT',
    });

    logger.logAction({
      callId: 'c3',
      sessionId: 's1',
      toolName: 'build_structure',
      rationale: 'Eco city behind front',
      status: 'failed',
      frameCapturedAtMs: 3000,
      modelEmittedAtMs: 3400,
      actionCompletedAtMs: 3600,
      scheduling: 'WHEN_IDLE',
      errorSummary: 'insufficient_gold_or_invalid_tile',
      artifacts: { verified: false },
    });

    logger.logSessionStatus({
      type: 'session_status',
      session_id: 's1',
      state: 'go_away',
      resumption_handle_present: true,
      timestamp_ms: 4000,
    });

    logger.logSessionStatus({
      type: 'session_status',
      session_id: 's1',
      state: 'resumed',
      resumption_handle_present: true,
      timestamp_ms: 4500,
    });

    const summary = logger.summarize();
    expect(summary.totalActions).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.errorCount).toBe(0);
    expect(summary.resumptionCount).toBe(1);
    // frame_to_action_ms values: 200, 350, 600
    expect(summary.frameToActionP50Ms).toBe(350);
    expect(summary.frameToActionP95Ms).toBe(600);
    // action_exec_ms values: 80, 100, 200
    expect(summary.actionExecP50Ms).toBe(100);
    expect(summary.actionExecP95Ms).toBe(200);
    expect(summary.sampleRationales).toHaveLength(3);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
