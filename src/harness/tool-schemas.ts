import { z } from 'zod';
import type { ToolName } from './contract-loader.js';

const NormalizedCoordSchema = z.number().finite().min(0).max(1);
const RationaleSchema = z.string().trim().min(1);
const RatioPctSchema = z.number().int().min(1).max(100);

export const SelectSpawnArgsSchema = z
  .object({
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    rationale: RationaleSchema,
  })
  .strict();

export const AttackTerritoryArgsSchema = z
  .object({
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    ratio_pct: RatioPctSchema.optional(),
    mode: z.enum(['ground', 'boat']).optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const SetAttackRatioArgsSchema = z
  .object({
    ratio_pct: RatioPctSchema,
    rationale: RationaleSchema,
  })
  .strict();

export const BuildStructureArgsSchema = z
  .object({
    structure: z.enum([
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
    ]),
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    rationale: RationaleSchema,
  })
  .strict();

export const LaunchSpecialArgsSchema = z
  .object({
    unit: z.enum(['warship', 'atom_bomb', 'hydrogen_bomb', 'mirv']),
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    rationale: RationaleSchema,
  })
  .strict();

export const DiplomacyActionArgsSchema = z
  .object({
    action: z.enum([
      'request_alliance',
      'break_alliance',
      'target_player',
      'donate_troops',
      'donate_gold',
      'embargo',
    ]),
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    rationale: RationaleSchema,
  })
  .strict();

export const CameraControlArgsSchema = z
  .object({
    pan: z.enum(['up', 'down', 'left', 'right']).optional(),
    pan_ms: z.number().int().min(100).max(800).optional(),
    zoom_steps: z.number().int().min(-5).max(5).optional(),
    toggle_alt_view: z.boolean().optional(),
    toggle_coord_grid: z.boolean().optional(),
    center_camera: z.boolean().optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const ZoomMapArgsSchema = z
  .object({
    direction: z.enum(['in', 'out']),
    steps: z.number().int().min(1).max(8),
    x: NormalizedCoordSchema.optional(),
    y: NormalizedCoordSchema.optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const PanMapArgsSchema = z
  .object({
    direction: z.enum([
      'up',
      'down',
      'left',
      'right',
      'up_left',
      'up_right',
      'down_left',
      'down_right',
    ]),
    duration_ms: z.number().int().min(100).max(1200),
    center_camera: z.boolean().optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const WaitObserveArgsSchema = z
  .object({
    duration_ms: z.number().int().min(500).max(5000),
    rationale: RationaleSchema,
  })
  .strict();

export const FocusRegionArgsSchema = z
  .object({
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    zoom_steps: z.number().int().min(1).max(6),
    rationale: RationaleSchema,
  })
  .strict();

export const ResetOverviewArgsSchema = z
  .object({
    zoom_out_steps: z.number().int().min(1).max(12).optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const ExpandBurstArgsSchema = z
  .object({
    x: NormalizedCoordSchema,
    y: NormalizedCoordSchema,
    spread: z.number().finite().min(0.02).max(0.15).optional(),
    count: z.number().int().min(3).max(4).optional(),
    ratio_pct: RatioPctSchema.optional(),
    rationale: RationaleSchema,
  })
  .strict();

export const ExecutePlanStepSchema = z
  .object({
    tool_name: z.enum([
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
      'expand_burst',
    ]),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ExecutePlanArgsSchema = z
  .object({
    actions: z.array(ExecutePlanStepSchema).min(1).max(5),
    step_delay_ms: z.number().int().min(80).max(250).optional(),
    rationale: RationaleSchema,
  })
  .strict();

export type SelectSpawnArgs = z.infer<typeof SelectSpawnArgsSchema>;
export type AttackTerritoryArgs = z.infer<typeof AttackTerritoryArgsSchema>;
export type SetAttackRatioArgs = z.infer<typeof SetAttackRatioArgsSchema>;
export type BuildStructureArgs = z.infer<typeof BuildStructureArgsSchema>;
export type LaunchSpecialArgs = z.infer<typeof LaunchSpecialArgsSchema>;
export type DiplomacyActionArgs = z.infer<typeof DiplomacyActionArgsSchema>;
export type CameraControlArgs = z.infer<typeof CameraControlArgsSchema>;
export type ZoomMapArgs = z.infer<typeof ZoomMapArgsSchema>;
export type PanMapArgs = z.infer<typeof PanMapArgsSchema>;
export type WaitObserveArgs = z.infer<typeof WaitObserveArgsSchema>;
export type FocusRegionArgs = z.infer<typeof FocusRegionArgsSchema>;
export type ResetOverviewArgs = z.infer<typeof ResetOverviewArgsSchema>;
export type ExpandBurstArgs = z.infer<typeof ExpandBurstArgsSchema>;
export type ExecutePlanStep = z.infer<typeof ExecutePlanStepSchema>;
export type ExecutePlanArgs = z.infer<typeof ExecutePlanArgsSchema>;

export interface ToolArgsByName {
  readonly select_spawn: SelectSpawnArgs;
  readonly attack_territory: AttackTerritoryArgs;
  readonly set_attack_ratio: SetAttackRatioArgs;
  readonly build_structure: BuildStructureArgs;
  readonly launch_special: LaunchSpecialArgs;
  readonly diplomacy_action: DiplomacyActionArgs;
  readonly camera_control: CameraControlArgs;
  readonly zoom_map: ZoomMapArgs;
  readonly pan_map: PanMapArgs;
  readonly wait_observe: WaitObserveArgs;
  readonly focus_region: FocusRegionArgs;
  readonly reset_overview: ResetOverviewArgs;
  readonly execute_plan: ExecutePlanArgs;
  readonly expand_burst: ExpandBurstArgs;
}

export const TOOL_ARG_SCHEMAS: Readonly<{ [K in ToolName]: z.ZodType<ToolArgsByName[K]> }> = {
  select_spawn: SelectSpawnArgsSchema,
  attack_territory: AttackTerritoryArgsSchema,
  set_attack_ratio: SetAttackRatioArgsSchema,
  build_structure: BuildStructureArgsSchema,
  launch_special: LaunchSpecialArgsSchema,
  diplomacy_action: DiplomacyActionArgsSchema,
  camera_control: CameraControlArgsSchema,
  zoom_map: ZoomMapArgsSchema,
  pan_map: PanMapArgsSchema,
  wait_observe: WaitObserveArgsSchema,
  focus_region: FocusRegionArgsSchema,
  reset_overview: ResetOverviewArgsSchema,
  execute_plan: ExecutePlanArgsSchema,
  expand_burst: ExpandBurstArgsSchema,
};
