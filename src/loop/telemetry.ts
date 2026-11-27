import fs from 'node:fs';
import path from 'node:path';
import type { SessionStatus } from '../harness/contract-loader.js';

export interface ActionTelemetryInput {
  readonly callId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly rationale: string;
  readonly status: 'success' | 'warning' | 'failed' | 'error';
  readonly frameCapturedAtMs: number;
  readonly modelEmittedAtMs: number;
  readonly actionCompletedAtMs: number;
  readonly scheduling: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT';
  readonly errorSummary?: string;
  readonly artifacts?: Readonly<Record<string, unknown>>;
}

export interface ActionTelemetryEntry extends ActionTelemetryInput {
  readonly kind: 'action';
  readonly frameToActionMs: number;
  readonly actionExecMs: number;
}

export interface SessionTelemetryEntry {
  readonly kind: 'session_status';
  readonly sessionId: string;
  readonly state: SessionStatus['state'];
  readonly resumptionHandlePresent: boolean;
  readonly timestampMs: number;
}

export interface RationaleSample {
  readonly callId: string;
  readonly toolName: string;
  readonly status: 'success' | 'warning' | 'failed' | 'error';
  readonly rationale: string;
  readonly frameToActionMs: number;
}

export interface TelemetrySummary {
  readonly totalActions: number;
  readonly successCount: number;
  readonly warningCount: number;
  readonly failedCount: number;
  readonly errorCount: number;
  readonly resumptionCount: number;
  readonly goAwayCount: number;
  readonly frameToActionP50Ms: number;
  readonly frameToActionP95Ms: number;
  readonly actionExecP50Ms: number;
  readonly actionExecP95Ms: number;
  readonly sampleRationales: readonly RationaleSample[];
  readonly logFilePath: string;
}

export interface TelemetryLoggerOptions {
  readonly logFilePath: string;
  readonly maxSampleRationales?: number;
}

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

/**
 * Writes structured JSONL telemetry for actions, tactical rationales, latency breakdowns,
 * and Gemini Live session resumption events.
 */
export class TelemetryLogger {
  readonly logFilePath: string;
  private readonly maxSampleRationales: number;
  private readonly actionEntries: ActionTelemetryEntry[] = [];
  private readonly sessionEntries: SessionTelemetryEntry[] = [];

  constructor(options: TelemetryLoggerOptions) {
    this.logFilePath = options.logFilePath;
    this.maxSampleRationales = options.maxSampleRationales ?? 10;
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
  }

  logAction(input: ActionTelemetryInput): ActionTelemetryEntry {
    const frameToActionMs = Math.max(0, input.actionCompletedAtMs - input.frameCapturedAtMs);
    const actionExecMs = Math.max(0, input.actionCompletedAtMs - input.modelEmittedAtMs);
    const entry: ActionTelemetryEntry = {
      ...input,
      kind: 'action',
      frameToActionMs,
      actionExecMs,
    };
    this.actionEntries.push(entry);
    this.appendLine(entry);
    return entry;
  }

  logSessionStatus(status: SessionStatus): SessionTelemetryEntry {
    const entry: SessionTelemetryEntry = {
      kind: 'session_status',
      sessionId: status.session_id,
      state: status.state,
      resumptionHandlePresent: status.resumption_handle_present,
      timestampMs: status.timestamp_ms,
    };
    this.sessionEntries.push(entry);
    this.appendLine(entry);
    return entry;
  }

  summarize(): TelemetrySummary {
    const frameLatencies = this.actionEntries
      .map((entry) => entry.frameToActionMs)
      .sort((a, b) => a - b);
    const execLatencies = this.actionEntries
      .map((entry) => entry.actionExecMs)
      .sort((a, b) => a - b);

    const successCount = this.actionEntries.filter((e) => e.status === 'success').length;
    const warningCount = this.actionEntries.filter((e) => e.status === 'warning').length;
    const failedCount = this.actionEntries.filter((e) => e.status === 'failed').length;
    const errorCount = this.actionEntries.filter((e) => e.status === 'error').length;
    const resumptionCount = this.sessionEntries.filter((e) => e.state === 'resumed').length;
    const goAwayCount = this.sessionEntries.filter((e) => e.state === 'go_away').length;

    const sampleRationales = this.actionEntries
      .slice(-this.maxSampleRationales)
      .map((entry) => ({
        callId: entry.callId,
        toolName: entry.toolName,
        status: entry.status,
        rationale: entry.rationale,
        frameToActionMs: entry.frameToActionMs,
      }));

    return {
      totalActions: this.actionEntries.length,
      successCount,
      warningCount,
      failedCount,
      errorCount,
      resumptionCount,
      goAwayCount,
      frameToActionP50Ms: computePercentile(frameLatencies, 50),
      frameToActionP95Ms: computePercentile(frameLatencies, 95),
      actionExecP50Ms: computePercentile(execLatencies, 50),
      actionExecP95Ms: computePercentile(execLatencies, 95),
      sampleRationales,
      logFilePath: this.logFilePath,
    };
  }

  private appendLine(payload: ActionTelemetryEntry | SessionTelemetryEntry): void {
    fs.appendFileSync(this.logFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
}
