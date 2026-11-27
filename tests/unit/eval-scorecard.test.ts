import { describe, expect, it } from 'vitest';
import {
  buildComparisonScorecard,
  computeMatchMetricsFromLines,
  formatScorecardMarkdown,
} from '../../src/eval/scorecard.js';

describe('Eval Scorecard Harness', () => {
  it('computes Phase 4 vs Phase 5 metrics including actionsAfter165s, camera tools, and p50/p95', () => {
    const baselineLines = [
      JSON.stringify({ kind: 'session_status', state: 'connected', timestampMs: 1_000 }),
      JSON.stringify({
        kind: 'action',
        toolName: 'select_spawn',
        status: 'success',
        actionCompletedAtMs: 5_000,
        frameToActionMs: 4000,
        actionExecMs: 1200,
      }),
      JSON.stringify({
        kind: 'action',
        toolName: 'attack_territory',
        status: 'success',
        actionCompletedAtMs: 120_000,
        frameToActionMs: 4040,
        actionExecMs: 3800,
      }),
      JSON.stringify({ kind: 'session_status', state: 'go_away', timestampMs: 540_000 }),
      JSON.stringify({ kind: 'session_status', state: 'resumed', timestampMs: 540_800 }),
    ];

    const candidateLines = [
      JSON.stringify({ kind: 'session_status', state: 'connected', timestampMs: 1_000 }),
      JSON.stringify({
        kind: 'action',
        toolName: 'zoom_map',
        status: 'success',
        actionCompletedAtMs: 4_000,
        frameToActionMs: 850,
        actionExecMs: 120,
      }),
      JSON.stringify({
        kind: 'action',
        toolName: 'pan_map',
        status: 'success',
        actionCompletedAtMs: 180_000,
        frameToActionMs: 900,
        actionExecMs: 350,
      }),
      JSON.stringify({
        kind: 'action',
        toolName: 'attack_territory',
        status: 'success',
        actionCompletedAtMs: 250_000,
        frameToActionMs: 750,
        actionExecMs: 90,
      }),
      JSON.stringify({
        kind: 'action',
        toolName: 'wait_observe',
        status: 'success',
        actionCompletedAtMs: 260_000,
        frameToActionMs: 950,
        actionExecMs: 1010,
      }),
    ];

    const baseline = computeMatchMetricsFromLines(baselineLines, {
      label: 'Phase 4',
      logFilePath: 'logs/phase4.jsonl',
      durationSeconds: 660,
    });
    const candidate = computeMatchMetricsFromLines(candidateLines, {
      label: 'Phase 5',
      logFilePath: 'logs/phase5.jsonl',
      durationSeconds: 330,
      bridgeCounters: { ticks_sent: 50, watchdog_nudges_sent: 1, watchdog_resets_sent: 0 },
    });

    expect(baseline.actionsAfter165s).toBe(0);
    expect(baseline.activeActionsAfter165s).toBe(0);
    expect(baseline.activeActions).toBe(2);
    expect(baseline.waitObserveCount).toBe(0);
    expect(baseline.goAwayCount).toBe(1);
    expect(baseline.resumptionCount).toBe(1);

    expect(candidate.totalActions).toBe(4);
    expect(candidate.activeActions).toBe(3);
    expect(candidate.waitObserveCount).toBe(1);
    expect(candidate.actionsAfter165s).toBe(3);
    expect(candidate.activeActionsAfter165s).toBe(2);
    expect(candidate.activeActionsPerMinute).toBeCloseTo(3 / 5.5, 5);
    expect(candidate.zoomMapCount).toBe(1);
    expect(candidate.panMapCount).toBe(1);
    expect(candidate.cameraActionCount).toBe(2);
    expect(candidate.watchdogNudges).toBe(1);

    const scorecard = buildComparisonScorecard(baseline, candidate);
    const md = formatScorecardMarkdown(scorecard);
    expect(md).toContain('| Active Actions (excl. wait_observe) | 2 | 3 | +1 |');
    expect(md).toContain('| wait_observe Calls | 0 | 1 | +1 |');
    expect(md).toContain('| Active Actions / Min | 0.18 | 0.55 | +0.4 |');
    expect(md).toContain('| Active Actions Past 165s | 0 | 2 | +2 |');
    expect(md).toContain('| Camera Tools (zoom_map / pan_map) | 0 / 0 | 1 / 1 | +2 |');
    expect(md).toContain('| frameToAction p50 |');
  });

  it('expands execute_plan batches and tracks verified builds, camera macros, and dual-brain latencies', () => {
    const dualLines = [
      JSON.stringify({ kind: 'session_status', state: 'connected', timestampMs: 1_000 }),
      JSON.stringify({
        kind: 'action',
        toolName: 'execute_plan',
        status: 'failed',
        actionCompletedAtMs: 180_000,
        frameToActionMs: 1400,
        actionExecMs: 520,
        artifacts: {
          stepResults: [
            { toolName: 'focus_region', status: 'success', artifacts: { zoomSteps: 3 } },
            {
              toolName: 'expand_burst',
              status: 'success',
              artifacts: {
                stepResults: [
                  { toolName: 'attack_territory', status: 'success', artifacts: { burst: true } },
                  { toolName: 'attack_territory', status: 'success', artifacts: { burst: true } },
                  { toolName: 'attack_territory', status: 'success', artifacts: { burst: true } },
                  { toolName: 'attack_territory', status: 'success', artifacts: { burst: true } },
                ],
              },
            },
            { toolName: 'build_structure', status: 'success', artifacts: { verified: true } },
            {
              toolName: 'build_structure',
              status: 'failed',
              artifacts: { verified: false, reason: 'insufficient_gold_or_invalid_tile' },
            },
          ],
        },
      }),
      JSON.stringify({
        kind: 'action',
        toolName: 'reset_overview',
        status: 'success',
        actionCompletedAtMs: 190_000,
        frameToActionMs: 1100,
        actionExecMs: 180,
      }),
    ];

    const baseline = computeMatchMetricsFromLines([], {
      label: 'Phase 5.1',
      logFilePath: 'logs/p51.jsonl',
      durationSeconds: 90,
    });
    const candidate = computeMatchMetricsFromLines(dualLines, {
      label: 'Phase 6',
      logFilePath: 'logs/p6.jsonl',
      durationSeconds: 180,
      bridgeCounters: {
        dual_brain: {
          system1_p50_ms: 820,
          system1_p95_ms: 1150,
          system2_p50_ms: 1650,
          system2_p95_ms: 1950,
          system2_refreshes_succeeded: 6,
          system2_refreshes_failed: 0,
          reasoning_tokens_total: 0,
        },
      },
    });

    expect(candidate.planBatchCount).toBe(1);
    expect(candidate.expandBurstCount).toBe(1);
    expect(candidate.totalActions).toBe(8);
    expect(candidate.activeActions).toBe(8);
    expect(candidate.verifiedBuildsSucceeded).toBe(1);
    expect(candidate.verifiedBuildsFailed).toBe(1);
    expect(candidate.failedCount).toBe(1);
    expect(candidate.focusRegionCount).toBe(1);
    expect(candidate.resetOverviewCount).toBe(1);
    expect(candidate.cameraMacroCount).toBe(2);
    expect(candidate.system1P50Ms).toBe(820);
    expect(candidate.system2RefreshesSucceeded).toBe(6);

    const md = formatScorecardMarkdown(buildComparisonScorecard(baseline, candidate));
    expect(md).toContain('| Verified Builds (OK / Failed) | 0 / 0 | 1 / 1 | +1 |');
    expect(md).toContain('| Camera Macros (focus_region / reset_overview) | 0 / 0 | 1 / 1 | +2 |');
    expect(md).toContain('| System 1 Inference p50 / p95 | 0.0 / 0.0 ms | 820.0 / 1150.0 ms | +820 ms |');
    expect(md).toContain('| System 2 Refresh p50 / p95 | 0.0 / 0.0 ms | 1650.0 / 1950.0 ms | +6 |');
  });
});
