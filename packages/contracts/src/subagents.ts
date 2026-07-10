import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PI_SUBAGENT_EVENT_CONTRACT_VERSION = 1 as const;
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const PiSubagentRunStatus = Schema.Literals([
  "spawning",
  "running",
  "needs_input",
  "done",
  "failed",
  "killed",
  "interrupted",
]);
export type PiSubagentRunStatus = typeof PiSubagentRunStatus.Type;

export const PiSubagentEventKind = Schema.Literals([
  "run_created",
  "run_running",
  "child_message",
  "child_tool",
  "child_turn",
  "progress",
  "manager_request",
  "manager_checkpoint",
  "needs_input",
  "resumed",
  "steered",
  "terminal",
  "killed",
  "interrupted",
  "control_result",
  "snapshot",
]);
export type PiSubagentEventKind = typeof PiSubagentEventKind.Type;

export const PiSubagentUsage = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  total: NonNegativeInt,
  turns: NonNegativeInt,
  cost_estimate_usd: NonNegativeNumber,
});
export type PiSubagentUsage = typeof PiSubagentUsage.Type;

export const PiSubagentResultJson = Schema.Struct({
  status: Schema.Literals(["done", "failed", "needs_input"]),
  summary: Schema.String,
  files_changed: Schema.Array(Schema.String),
  open_questions: Schema.Array(Schema.String),
});
export type PiSubagentResultJson = typeof PiSubagentResultJson.Type;

export const PiSubagentRunResult = Schema.Struct({
  run_id: TrimmedNonEmptyString,
  model: Schema.String,
  directory: Schema.String,
  status: PiSubagentRunStatus,
  result: Schema.optional(PiSubagentResultJson),
  reason: Schema.optional(Schema.String),
  usage: PiSubagentUsage,
  session_file: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(Schema.String)),
});
export type PiSubagentRunResult = typeof PiSubagentRunResult.Type;

export const PiSubagentManagerRequest = Schema.Struct({
  message: Schema.String,
  note: Schema.optional(Schema.String),
  turn: NonNegativeInt,
  tokens: NonNegativeInt,
  timestamp: NonNegativeNumber,
});
export type PiSubagentManagerRequest = typeof PiSubagentManagerRequest.Type;

export const PiSubagentRunView = Schema.Struct({
  runId: TrimmedNonEmptyString,
  task: Schema.String,
  model: Schema.String,
  state: PiSubagentRunStatus,
  directory: Schema.String,
  skills: Schema.Array(Schema.String),
  progressNote: Schema.optional(Schema.String),
  turns: NonNegativeInt,
  activeMs: NonNegativeNumber,
  usageSoFar: PiSubagentUsage,
  openQuestions: Schema.Array(Schema.String),
  result: Schema.optional(PiSubagentRunResult),
  checkAfterTokens: NonNegativeInt,
  nextCheckTokens: NonNegativeInt,
  managerCheckPending: Schema.Boolean,
  managerRequest: Schema.optional(PiSubagentManagerRequest),
});
export type PiSubagentRunView = typeof PiSubagentRunView.Type;

export const PiSubagentChildActivity = Schema.Struct({
  type: TrimmedNonEmptyString,
  data: Schema.Record(Schema.String, Schema.Unknown),
  liveOnly: Schema.optional(Schema.Boolean),
});
export type PiSubagentChildActivity = typeof PiSubagentChildActivity.Type;

export const PiSubagentControlAction = Schema.Literals([
  "status",
  "replay",
  "steer",
  "reply",
  "kill",
]);
export type PiSubagentControlAction = typeof PiSubagentControlAction.Type;

export const PiSubagentControlResult = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  action: PiSubagentControlAction,
  success: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type PiSubagentControlResult = typeof PiSubagentControlResult.Type;

const PiSubagentReplayEvent = Schema.Struct({
  contractVersion: Schema.Literal(PI_SUBAGENT_EVENT_CONTRACT_VERSION),
  managerId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  timestamp: IsoDateTime,
  kind: PiSubagentEventKind,
  runId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(PiSubagentRunView),
  activity: Schema.optional(PiSubagentChildActivity),
  control: Schema.optional(PiSubagentControlResult),
  replay: Schema.optional(Schema.Boolean),
});
export type PiSubagentReplayEvent = typeof PiSubagentReplayEvent.Type;

export const PiSubagentSnapshot = Schema.Struct({
  runs: Schema.Array(PiSubagentRunView),
  events: Schema.optional(Schema.Array(PiSubagentReplayEvent)),
  requestId: Schema.optional(Schema.String),
  replay: Schema.optional(Schema.Boolean),
});
export type PiSubagentSnapshot = typeof PiSubagentSnapshot.Type;

export const PiSubagentEvent = Schema.Struct({
  contractVersion: Schema.Literal(PI_SUBAGENT_EVENT_CONTRACT_VERSION),
  managerId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  timestamp: IsoDateTime,
  kind: PiSubagentEventKind,
  runId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(PiSubagentRunView),
  activity: Schema.optional(PiSubagentChildActivity),
  control: Schema.optional(PiSubagentControlResult),
  snapshot: Schema.optional(PiSubagentSnapshot),
  replay: Schema.optional(Schema.Boolean),
});
export type PiSubagentEvent = typeof PiSubagentEvent.Type;

const PiSubagentControlBase = {
  threadId: ThreadId,
  requestId: Schema.optional(TrimmedNonEmptyString),
} as const;

export const PiSubagentControlInput = Schema.Union([
  Schema.Struct({
    ...PiSubagentControlBase,
    action: Schema.Literal("status"),
    runId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...PiSubagentControlBase,
    action: Schema.Literal("replay"),
    runId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...PiSubagentControlBase,
    action: Schema.Literal("steer"),
    runId: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...PiSubagentControlBase,
    action: Schema.Literal("reply"),
    runId: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...PiSubagentControlBase,
    action: Schema.Literal("kill"),
    runId: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
]);
export type PiSubagentControlInput = typeof PiSubagentControlInput.Type;

export const PiSubagentSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type PiSubagentSubscribeInput = typeof PiSubagentSubscribeInput.Type;

export class PiSubagentControlError extends Schema.TaggedErrorClass<PiSubagentControlError>()(
  "PiSubagentControlError",
  {
    message: Schema.String,
  },
) {}
