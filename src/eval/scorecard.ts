import fs from 'node:fs';
import { z } from 'zod';

const ActionLineSchema = z.object({
  kind: z.literal('action'),
  toolName: z.string().min(1),
  status: z.enum(['success', 'warning', 'failed', 'error']),
  actionCompletedAtMs: z.number().finite().nonnegative(),
  frameToActionMs: z.number().finite().nonnegative(),
  actionExecMs: z.number().finite().nonnegative(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
});

const StepResultSchema = z.object({
  toolName: z.string().min(1),
  status: z.enum(['success', 'warning', 'failed', 'error']),
  artifacts: z.record(z.string(), z.unknown()).optional(),
});

const SessionLineSchema = z.object({
  kind: z.literal('session_status'),
  state: z.enum(['connected', 'go_away', 'resumed', 'reconnecting', 'closed', 'error']),
  timestampMs: z.number().finite().nonnegative(),
});

export interface DualBrainEvalCounters {
  readonly system1_p50_ms?: number;
  readonly system1_p95_ms?: number;
  readonly system2_p50_ms?: number;
  readonly system2_p95_ms?: number;
  readonly system2_refreshes_succeeded?: number;
  readonly system2_refreshes_failed?: number;
  readonly reasoning_tokens_total?: number;
}

export interface BridgeHealthEvalCounters {
  readonly ticks_sent?: number;
  readonly watchdog_nudges_sent?: number;
  readonly watchdog_resets_sent?: number;
  readonly dual_brain?: DualBrainEvalCounters | null;
}

export interface EvalMatchMetrics {
  readonly label: string;
  readonly logFilePath: string;
  readonly durationSeconds: number;
  readonly totalActions: number;
  readonly activeActions: number;
  readonly waitObserveCount: number;
  readonly planBatchCount: number;
  readonly successCount: number;
  readonly warningCount: number;
  readonly failedCount: number;
  readonly errorCount: number;
  readonly validActionRate: number;
  readonly actionsAfter165s: number;
  readonly activeActionsAfter165s: number;
  readonly actionsPerMinute: number;
  readonly activeActionsPerMinute: number;
  readonly zoomMapCount: number;
  readonly panMapCount: number;
  readonly focusRegionCount: number;
  readonly resetOverviewCount: number;
  readonly expandBurstCount: number;
  readonly cameraActionCount: number;
  readonly cameraMacroCount: number;
  readonly verifiedBuildsSucceeded: number;
  readonly verifiedBuildsFailed: number;
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly frameToActionP50Ms: number;
  readonly frameToActionP95Ms: number;
  readonly actionExecP50Ms: number;
  readonly actionExecP95Ms: number;
  readonly resumptionCount: number;
  readonly goAwayCount: number;
  readonly ticksSent: number;
  readonly watchdogNudges: number;
  readonly watchdogResets: number;
  readonly system1P50Ms: number;
  readonly system1P95Ms: number;
  readonly system2P50Ms: number;
  readonly system2P95Ms: number;
  readonly system2RefreshesSucceeded: number;
  readonly system2RefreshesFailed: number;
  readonly reasoningTokensTotal: number;
}

export interface EvalScorecardRow {
  readonly metric: string;
  readonly before: string;
  readonly after: string;
  readonly delta: string;
}

export interface EvalComparisonScorecard {
  readonly baseline: EvalMatchMetrics;
  readonly candidate: EvalMatchMetrics;
  readonly rows: readonly EvalScorecardRow[];
}

function percentile(sorted: readonly number[], pct: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function isBuildLikeTool(toolName: string): boolean {
  return toolName === 'build_structure' || toolName === 'launch_special';
}

export function computeMatchMetricsFromLines(
  lines: readonly string[],
  options: {
    readonly label: string;
    readonly logFilePath: string;
    readonly durationSeconds: number;
    readonly bridgeCounters?: BridgeHealthEvalCounters;
  },
): EvalMatchMetrics {
  const actions: Array<z.infer<typeof ActionLineSchema>> = [];
  const sessions: Array<z.infer<typeof SessionLineSchema>> = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const actionRes = ActionLineSchema.safeParse(parsed);
    if (actionRes.success) {
      actions.push(actionRes.data);
      continue;
    }
    const sessionRes = SessionLineSchema.safeParse(parsed);
    if (sessionRes.success) {
      sessions.push(sessionRes.data);
    }
  }

  const startMs =
    sessions.length > 0
      ? Math.min(...sessions.map((s) => s.timestampMs))
      : actions.length > 0
        ? actions[0]!.actionCompletedAtMs
        : 0;

  let expandedTotalActions = 0;
  let successCount = 0;
  let warningCount = 0;
  let failedCount = 0;
  let errorCount = 0;
  let actionsAfter165s = 0;
  let activeActionsAfter165s = 0;
  let waitObserveCount = 0;
  let planBatchCount = 0;
  let expandBurstCount = 0;
  let verifiedBuildsSucceeded = 0;
  let verifiedBuildsFailed = 0;
  const toolCounts: Record<string, number> = {};
  const frameToActionList: number[] = [];
  const actionExecList: number[] = [];

  const recordStep = (
    toolName: string,
    status: 'success' | 'warning' | 'failed' | 'error',
    artifacts: Readonly<Record<string, unknown>> | undefined,
    completedAtMs: number,
  ): void => {
    if (toolName === 'expand_burst') {
      expandBurstCount += 1;
      const nestedSteps = artifacts?.['stepResults'];
      if (Array.isArray(nestedSteps) && nestedSteps.length > 0) {
        for (const nestedRaw of nestedSteps) {
          const parsedNested = StepResultSchema.safeParse(nestedRaw);
          if (parsedNested.success) {
            recordStep(
              parsedNested.data.toolName,
              parsedNested.data.status,
              parsedNested.data.artifacts,
              completedAtMs,
            );
          }
        }
        return;
      }
    }

    expandedTotalActions += 1;
    if (status === 'success') {
      successCount += 1;
    } else if (status === 'warning') {
      warningCount += 1;
    } else if (status === 'failed') {
      failedCount += 1;
    } else {
      errorCount += 1;
    }

    const isWaitObserve = toolName === 'wait_observe';
    if (isWaitObserve) {
      waitObserveCount += 1;
    }
    if (completedAtMs - startMs >= 165_000) {
      actionsAfter165s += 1;
      if (!isWaitObserve) {
        activeActionsAfter165s += 1;
      }
    }
    toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;

    if (isBuildLikeTool(toolName)) {
      const verified = artifacts?.['verified'];
      if (verified === true || (verified !== false && status === 'success')) {
        verifiedBuildsSucceeded += 1;
      } else if (verified === false || status === 'failed') {
        verifiedBuildsFailed += 1;
      }
    }
  };

  for (const entry of actions) {
    frameToActionList.push(entry.frameToActionMs);
    actionExecList.push(entry.actionExecMs);

    if (entry.toolName === 'execute_plan') {
      planBatchCount += 1;
      const rawSteps = entry.artifacts?.['stepResults'];
      if (Array.isArray(rawSteps) && rawSteps.length > 0) {
        for (const rawStep of rawSteps) {
          const parsedStep = StepResultSchema.safeParse(rawStep);
          if (parsedStep.success) {
            recordStep(
              parsedStep.data.toolName,
              parsedStep.data.status,
              parsedStep.data.artifacts,
              entry.actionCompletedAtMs,
            );
          }
        }
        continue;
      }
    }

    recordStep(entry.toolName, entry.status, entry.artifacts, entry.actionCompletedAtMs);
  }

  frameToActionList.sort((a, b) => a - b);
  actionExecList.sort((a, b) => a - b);

  const activeActions = expandedTotalActions - waitObserveCount;
  const zoomMapCount = toolCounts['zoom_map'] ?? 0;
  const panMapCount = toolCounts['pan_map'] ?? 0;
  const focusRegionCount = toolCounts['focus_region'] ?? 0;
  const resetOverviewCount = toolCounts['reset_overview'] ?? 0;
  const legacyCameraCount = toolCounts['camera_control'] ?? 0;
  const cameraMacroCount = focusRegionCount + resetOverviewCount;
  const durationMinutes = Math.max(options.durationSeconds / 60, 1 / 60);
  const dualBrain = options.bridgeCounters?.dual_brain;

  return {
    label: options.label,
    logFilePath: options.logFilePath,
    durationSeconds: options.durationSeconds,
    totalActions: expandedTotalActions,
    activeActions,
    waitObserveCount,
    planBatchCount,
    successCount,
    warningCount,
    failedCount,
    errorCount,
    validActionRate: expandedTotalActions > 0 ? successCount / expandedTotalActions : 0,
    actionsAfter165s,
    activeActionsAfter165s,
    actionsPerMinute: expandedTotalActions / durationMinutes,
    activeActionsPerMinute: activeActions / durationMinutes,
    zoomMapCount,
    panMapCount,
    focusRegionCount,
    resetOverviewCount,
    expandBurstCount,
    cameraActionCount: zoomMapCount + panMapCount + legacyCameraCount + cameraMacroCount,
    cameraMacroCount,
    verifiedBuildsSucceeded,
    verifiedBuildsFailed,
    toolCounts,
    frameToActionP50Ms: percentile(frameToActionList, 50),
    frameToActionP95Ms: percentile(frameToActionList, 95),
    actionExecP50Ms: percentile(actionExecList, 50),
    actionExecP95Ms: percentile(actionExecList, 95),
    resumptionCount: sessions.filter((s) => s.state === 'resumed').length,
    goAwayCount: sessions.filter((s) => s.state === 'go_away').length,
    ticksSent: options.bridgeCounters?.ticks_sent ?? 0,
    watchdogNudges: options.bridgeCounters?.watchdog_nudges_sent ?? 0,
    watchdogResets: options.bridgeCounters?.watchdog_resets_sent ?? 0,
    system1P50Ms: dualBrain?.system1_p50_ms ?? 0,
    system1P95Ms: dualBrain?.system1_p95_ms ?? 0,
    system2P50Ms: dualBrain?.system2_p50_ms ?? 0,
    system2P95Ms: dualBrain?.system2_p95_ms ?? 0,
    system2RefreshesSucceeded: dualBrain?.system2_refreshes_succeeded ?? 0,
    system2RefreshesFailed: dualBrain?.system2_refreshes_failed ?? 0,
    reasoningTokensTotal: dualBrain?.reasoning_tokens_total ?? 0,
  };
}

export function computeMatchMetrics(options: {
  readonly label: string;
  readonly logFilePath: string;
  readonly durationSeconds: number;
  readonly bridgeCounters?: BridgeHealthEvalCounters;
}): EvalMatchMetrics {
  const raw = fs.readFileSync(options.logFilePath, 'utf8');
  return computeMatchMetricsFromLines(raw.split(/\r?\n/), options);
}

function formatSignedDelta(after: number, before: number, unit = ''): string {
  const diff = after - before;
  const sign = diff > 0 ? '+' : '';
  const rounded = Number.isInteger(diff) ? String(diff) : diff.toFixed(1);
  return `${sign}${rounded}${unit}`;
}

export function buildComparisonScorecard(
  baseline: EvalMatchMetrics,
  candidate: EvalMatchMetrics,
): EvalComparisonScorecard {
  const rows: EvalScorecardRow[] = [
    {
      metric: 'Match Duration',
      before: `${baseline.durationSeconds}s`,
      after: `${candidate.durationSeconds}s`,
      delta: formatSignedDelta(candidate.durationSeconds, baseline.durationSeconds, 's'),
    },
    {
      metric: 'Active Actions (excl. wait_observe)',
      before: `${baseline.activeActions}`,
      after: `${candidate.activeActions}`,
      delta: formatSignedDelta(candidate.activeActions, baseline.activeActions),
    },
    {
      metric: 'wait_observe Calls',
      before: `${baseline.waitObserveCount}`,
      after: `${candidate.waitObserveCount}`,
      delta: formatSignedDelta(candidate.waitObserveCount, baseline.waitObserveCount),
    },
    {
      metric: 'Total Actions',
      before: `${baseline.totalActions}`,
      after: `${candidate.totalActions}`,
      delta: formatSignedDelta(candidate.totalActions, baseline.totalActions),
    },
    {
      metric: 'Active Actions / Min',
      before: baseline.activeActionsPerMinute.toFixed(2),
      after: candidate.activeActionsPerMinute.toFixed(2),
      delta: formatSignedDelta(candidate.activeActionsPerMinute, baseline.activeActionsPerMinute),
    },
    {
      metric: 'Active Actions Past 165s',
      before: `${baseline.activeActionsAfter165s}`,
      after: `${candidate.activeActionsAfter165s}`,
      delta: formatSignedDelta(candidate.activeActionsAfter165s, baseline.activeActionsAfter165s),
    },
    {
      metric: 'Valid Action Rate',
      before: `${(baseline.validActionRate * 100).toFixed(1)}%`,
      after: `${(candidate.validActionRate * 100).toFixed(1)}%`,
      delta: formatSignedDelta(
        candidate.validActionRate * 100,
        baseline.validActionRate * 100,
        '%',
      ),
    },
    {
      metric: 'Verified Builds (OK / Failed)',
      before: `${baseline.verifiedBuildsSucceeded} / ${baseline.verifiedBuildsFailed}`,
      after: `${candidate.verifiedBuildsSucceeded} / ${candidate.verifiedBuildsFailed}`,
      delta: formatSignedDelta(
        candidate.verifiedBuildsSucceeded,
        baseline.verifiedBuildsSucceeded,
      ),
    },
    {
      metric: 'Camera Tools (zoom_map / pan_map)',
      before: `${baseline.zoomMapCount} / ${baseline.panMapCount}`,
      after: `${candidate.zoomMapCount} / ${candidate.panMapCount}`,
      delta: formatSignedDelta(candidate.cameraActionCount, baseline.cameraActionCount),
    },
    {
      metric: 'Camera Macros (focus_region / reset_overview)',
      before: `${baseline.focusRegionCount} / ${baseline.resetOverviewCount}`,
      after: `${candidate.focusRegionCount} / ${candidate.resetOverviewCount}`,
      delta: formatSignedDelta(candidate.cameraMacroCount, baseline.cameraMacroCount),
    },
    {
      metric: 'frameToAction p50',
      before: `${baseline.frameToActionP50Ms.toFixed(1)} ms`,
      after: `${candidate.frameToActionP50Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.frameToActionP50Ms, baseline.frameToActionP50Ms, ' ms'),
    },
    {
      metric: 'frameToAction p95',
      before: `${baseline.frameToActionP95Ms.toFixed(1)} ms`,
      after: `${candidate.frameToActionP95Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.frameToActionP95Ms, baseline.frameToActionP95Ms, ' ms'),
    },
    {
      metric: 'actionExec p50',
      before: `${baseline.actionExecP50Ms.toFixed(1)} ms`,
      after: `${candidate.actionExecP50Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.actionExecP50Ms, baseline.actionExecP50Ms, ' ms'),
    },
    {
      metric: 'actionExec p95',
      before: `${baseline.actionExecP95Ms.toFixed(1)} ms`,
      after: `${candidate.actionExecP95Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.actionExecP95Ms, baseline.actionExecP95Ms, ' ms'),
    },
    {
      metric: 'System 1 Inference p50 / p95',
      before: `${baseline.system1P50Ms.toFixed(1)} / ${baseline.system1P95Ms.toFixed(1)} ms`,
      after: `${candidate.system1P50Ms.toFixed(1)} / ${candidate.system1P95Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.system1P50Ms, baseline.system1P50Ms, ' ms'),
    },
    {
      metric: 'System 2 Refresh p50 / p95',
      before: `${baseline.system2P50Ms.toFixed(1)} / ${baseline.system2P95Ms.toFixed(1)} ms`,
      after: `${candidate.system2P50Ms.toFixed(1)} / ${candidate.system2P95Ms.toFixed(1)} ms`,
      delta: formatSignedDelta(candidate.system2RefreshesSucceeded, baseline.system2RefreshesSucceeded),
    },
    {
      metric: 'Watchdog Nudges / Resets',
      before: `${baseline.watchdogNudges} / ${baseline.watchdogResets}`,
      after: `${candidate.watchdogNudges} / ${candidate.watchdogResets}`,
      delta: formatSignedDelta(
        candidate.watchdogNudges + candidate.watchdogResets,
        baseline.watchdogNudges + baseline.watchdogResets,
      ),
    },
    {
      metric: 'GoAway / Resumed',
      before: `${baseline.goAwayCount} / ${baseline.resumptionCount}`,
      after: `${candidate.goAwayCount} / ${candidate.resumptionCount}`,
      delta: formatSignedDelta(candidate.resumptionCount, baseline.resumptionCount),
    },
  ];

  return { baseline, candidate, rows };
}

export function formatScorecardMarkdown(scorecard: EvalComparisonScorecard): string {
  const header = `| Metric | Before (${scorecard.baseline.label}) | After (${scorecard.candidate.label}) | Delta |`;
  const sep = '| :--- | :--- | :--- | :--- |';
  const body = scorecard.rows.map(
    (row) => `| ${row.metric} | ${row.before} | ${row.after} | ${row.delta} |`,
  );
  return [header, sep, ...body].join('\n');
}
