import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigValidationError } from '../errors/app-error.js';

export const TOOL_NAMES = [
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const EXPECTED_TOOL_SET = new Set<string>(TOOL_NAMES);

export const ActionRequestSchema = z.object({
  type: z.literal('action_request'),
  call_id: z.string().min(1),
  session_id: z.string().min(1),
  tool_name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  frame_captured_at_ms: z.number().finite().nonnegative(),
  model_emitted_at_ms: z.number().finite().nonnegative(),
});

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const RecoverySchema = z.object({
  root_cause: z.string().min(1),
  safe_retry: z.string().min(1),
  stop_condition: z.string().min(1),
});

export type RecoveryContract = z.infer<typeof RecoverySchema>;

export const ActionResponseSchema = z.object({
  type: z.literal('action_response'),
  call_id: z.string().min(1),
  status: z.enum(['success', 'warning', 'failed', 'error']),
  summary: z.string().min(1),
  next_actions: z.array(z.string()),
  artifacts: z.record(z.string(), z.unknown()),
  latency_ms: z.number().finite().nonnegative(),
  scheduling: z.enum(['SILENT', 'WHEN_IDLE', 'INTERRUPT']),
  recovery: RecoverySchema.optional(),
});

export type ActionResponse = z.infer<typeof ActionResponseSchema>;

export const HudSnapshotSchema = z.object({
  type: z.literal('hud_snapshot'),
  timestamp_ms: z.number().finite().nonnegative(),
  panel_visible: z.boolean(),
  game_over: z.boolean(),
  gold: z.number().finite().nonnegative().nullable().optional(),
  gold_text: z.string().nullable().optional(),
  troops: z.number().finite().nonnegative().nullable().optional(),
  max_troops: z.number().finite().nonnegative().nullable().optional(),
  troop_rate: z.string().nullable().optional(),
  attack_ratio_pct: z.number().int().min(0).max(100).nullable().optional(),
  match_timer: z.string().nullable().optional(),
  game_over_text: z.string().nullable().optional(),
});

export type HudSnapshot = z.infer<typeof HudSnapshotSchema>;

export const SessionStatusSchema = z.object({
  type: z.literal('session_status'),
  session_id: z.string().min(1),
  state: z.enum(['connected', 'go_away', 'resumed', 'reconnecting', 'closed', 'error']),
  resumption_handle_present: z.boolean(),
  timestamp_ms: z.number().finite().nonnegative(),
});

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const PingPongSchema = z.object({
  type: z.enum(['ping', 'pong']),
  timestamp_ms: z.number().finite().nonnegative(),
});

export type PingPongMessage = z.infer<typeof PingPongSchema>;

const GeminiFunctionDeclarationSchema = z.object({
  name: z.enum(TOOL_NAMES),
  description: z.string().min(1),
  behavior: z.literal('NON_BLOCKING'),
  parameters: z.object({
    type: z.literal('OBJECT'),
    properties: z.record(z.string(), z.record(z.string(), z.unknown())),
    required: z.array(z.string()),
  }),
});

export const ActionProtocolSchema = z
  .object({
    version: z.string().min(1),
    coordinate_space: z.object({
      min: z.literal(0),
      max: z.literal(1),
      origin: z.literal('top_left'),
      description: z.string().min(1),
    }),
    ipc: z.object({
      host: z.string().min(1),
      default_port: z.number().int().positive(),
      ws_action_path: z.string().startsWith('/'),
      http_health_path: z.string().startsWith('/'),
      http_webrtc_offer_path: z.string().startsWith('/'),
      message_schemas: z.record(z.string(), z.unknown()),
    }),
    gemini_function_declarations: z
      .array(GeminiFunctionDeclarationSchema)
      .length(TOOL_NAMES.length),
  })
  .superRefine((protocol, ctx) => {
    const declaredNames = new Set(
      protocol.gemini_function_declarations.map((decl) => decl.name),
    );
    if (declaredNames.size !== EXPECTED_TOOL_SET.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate or missing tool names in gemini_function_declarations',
      });
    }
    for (const expectedName of EXPECTED_TOOL_SET) {
      if (!declaredNames.has(expectedName as ToolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing required tool declaration: ${expectedName}`,
        });
      }
    }
  });

export type ActionProtocol = z.infer<typeof ActionProtocolSchema>;

function defaultContractPath(): string {
  return fileURLToPath(new URL('../../contracts/action-protocol.json', import.meta.url));
}

/**
 * Loads and validates an action-protocol JSON contract against the strict schema.
 */
export function loadActionProtocol(contractPath: string = defaultContractPath()): ActionProtocol {
  let rawText: string;
  try {
    rawText = readFileSync(contractPath, 'utf8');
  } catch (error) {
    throw new ConfigValidationError(`Failed to read action protocol at "${contractPath}"`, {
      contractPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    throw new ConfigValidationError(`Invalid JSON in action protocol at "${contractPath}"`, {
      contractPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const validated = ActionProtocolSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new ConfigValidationError(
      `Action protocol validation failed for "${contractPath}"`,
      validated.error.issues,
    );
  }

  return validated.data;
}

export const ACTION_PROTOCOL: ActionProtocol = loadActionProtocol();
