import { ToolValidationError } from '../errors/app-error.js';
import {
  ActionRequestSchema,
  ActionResponseSchema,
  TOOL_NAMES,
  type ActionRequest,
  type ActionResponse,
  type RecoveryContract,
  type ToolName,
} from './contract-loader.js';
import { TOOL_ARG_SCHEMAS, type ToolArgsByName } from './tool-schemas.js';

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

export type ParsedActionRequest = {
  [K in ToolName]: {
    readonly type: 'action_request';
    readonly call_id: string;
    readonly session_id: string;
    readonly tool_name: K;
    readonly arguments: ToolArgsByName[K];
    readonly frame_captured_at_ms: number;
    readonly model_emitted_at_ms: number;
  };
}[ToolName];

export interface CreateToolObservationInput {
  readonly callId: string;
  readonly status: 'success' | 'warning' | 'failed' | 'error';
  readonly summary: string;
  readonly nextActions: readonly string[];
  readonly artifacts: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
  readonly scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT';
  readonly recovery?: RecoveryContract;
}

const DEFAULT_ERROR_RECOVERY: RecoveryContract = {
  root_cause: 'Action execution failed',
  safe_retry: 'Re-read current game frame and retry with valid normalized [0..1] arguments',
  stop_condition: 'Stop retrying after 2 consecutive identical failures and call wait_observe',
};

function isToolName(name: string): name is ToolName {
  return TOOL_NAME_SET.has(name);
}

function defaultSchedulingForStatus(
  status: 'success' | 'warning' | 'failed' | 'error',
): 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT' {
  if (status === 'error') {
    return 'INTERRUPT';
  }
  if (status === 'warning' || status === 'failed') {
    return 'WHEN_IDLE';
  }
  return 'SILENT';
}

function parseToolArguments<K extends ToolName>(
  toolName: K,
  envelope: ActionRequest,
): ParsedActionRequest {
  const schema = TOOL_ARG_SCHEMAS[toolName];
  const parsedArgs = schema.safeParse(envelope.arguments);
  if (!parsedArgs.success) {
    throw new ToolValidationError(
      `Invalid arguments for tool "${toolName}"`,
      parsedArgs.error.issues,
    );
  }

  return {
    type: 'action_request',
    call_id: envelope.call_id,
    session_id: envelope.session_id,
    tool_name: toolName,
    arguments: parsedArgs.data,
    frame_captured_at_ms: envelope.frame_captured_at_ms,
    model_emitted_at_ms: envelope.model_emitted_at_ms,
  } as ParsedActionRequest;
}

/**
 * Parses and validates an incoming action_request object or JSON string against the IPC envelope
 * and the strict Zod schema of the target OpenFront tool.
 */
export function parseActionRequest(raw: unknown): ParsedActionRequest {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new ToolValidationError('Malformed JSON in action_request payload', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const envelopeResult = ActionRequestSchema.safeParse(payload);
  if (!envelopeResult.success) {
    throw new ToolValidationError(
      'Invalid action_request envelope',
      envelopeResult.error.issues,
    );
  }

  const envelope = envelopeResult.data;
  if (!isToolName(envelope.tool_name)) {
    throw new ToolValidationError(`Unsupported tool "${envelope.tool_name}"`, {
      toolName: envelope.tool_name,
      supportedTools: TOOL_NAMES,
    });
  }

  return parseToolArguments(envelope.tool_name, envelope);
}

/**
 * Builds a deterministic ActionResponse observation envelope conforming to contracts/action-protocol.json.
 */
export function createToolObservation(input: CreateToolObservationInput): ActionResponse {
  const scheduling = input.scheduling ?? defaultSchedulingForStatus(input.status);
  const recovery =
    input.recovery ?? (input.status === 'error' ? { ...DEFAULT_ERROR_RECOVERY } : undefined);

  const response: ActionResponse = {
    type: 'action_response',
    call_id: input.callId,
    status: input.status,
    summary: input.summary,
    next_actions: [...input.nextActions],
    artifacts: { ...input.artifacts },
    latency_ms: Math.max(0, Math.round(input.latencyMs)),
    scheduling,
    ...(recovery !== undefined ? { recovery: { ...recovery } } : {}),
  };

  const validated = ActionResponseSchema.safeParse(response);
  if (!validated.success) {
    throw new ToolValidationError('Invalid ActionResponse observation', validated.error.issues);
  }

  return validated.data;
}
