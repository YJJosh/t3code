import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Version of the Pi background-terminal extension event envelope. */
export const PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION = 1 as const;
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_SNAPSHOT_TERMINALS = 32;

export const PiBackgroundTerminalId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^bt-[1-9][0-9]*$/),
);
export type PiBackgroundTerminalId = typeof PiBackgroundTerminalId.Type;
const PiBackgroundTerminalRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PiBackgroundTerminalManagerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const PiBackgroundTerminalStatus = Schema.Literals(["running", "done", "failed", "killed"]);
export type PiBackgroundTerminalStatus = typeof PiBackgroundTerminalStatus.Type;

export const PiBackgroundTerminalOutputView = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS)),
  totalBytes: NonNegativeInt,
  truncatedBytes: NonNegativeInt,
});
export type PiBackgroundTerminalOutputView = typeof PiBackgroundTerminalOutputView.Type;

export const PiBackgroundTerminalView = Schema.Struct({
  id: PiBackgroundTerminalId,
  command: Schema.String.check(Schema.isMaxLength(16_384)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  cwd: Schema.String.check(Schema.isMaxLength(4_096)),
  pid: Schema.optional(PositiveInt),
  status: PiBackgroundTerminalStatus,
  createdAt: NonNegativeNumber,
  settledAt: Schema.optional(NonNegativeNumber),
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  errorText: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  stdout: PiBackgroundTerminalOutputView,
  stderr: PiBackgroundTerminalOutputView,
});
export type PiBackgroundTerminalView = typeof PiBackgroundTerminalView.Type;

export const PiBackgroundTerminalEventKind = Schema.Literals([
  "terminal_upsert",
  "terminal_output",
  "terminal_removed",
  "control_result",
  "snapshot",
]);
export type PiBackgroundTerminalEventKind = typeof PiBackgroundTerminalEventKind.Type;

export const PiBackgroundTerminalOutputDelta = Schema.Struct({
  terminalId: PiBackgroundTerminalId,
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS)),
  replace: Schema.Boolean,
  totalBytes: NonNegativeInt,
  truncatedBytes: NonNegativeInt,
});
export type PiBackgroundTerminalOutputDelta = typeof PiBackgroundTerminalOutputDelta.Type;

export const PiBackgroundTerminalControlAction = Schema.Literals(["replay", "kill"]);
export type PiBackgroundTerminalControlAction = typeof PiBackgroundTerminalControlAction.Type;

export const PiBackgroundTerminalControlResult = Schema.Struct({
  requestId: Schema.optional(PiBackgroundTerminalRequestId),
  action: PiBackgroundTerminalControlAction,
  success: Schema.Boolean,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});
export type PiBackgroundTerminalControlResult = typeof PiBackgroundTerminalControlResult.Type;

export const PiBackgroundTerminalSnapshot = Schema.Struct({
  terminals: Schema.Array(PiBackgroundTerminalView).check(
    Schema.isMaxLength(MAX_SNAPSHOT_TERMINALS),
  ),
  requestId: Schema.optional(PiBackgroundTerminalRequestId),
  replay: Schema.optional(Schema.Boolean),
});
export type PiBackgroundTerminalSnapshot = typeof PiBackgroundTerminalSnapshot.Type;

const PiBackgroundTerminalEventBase = {
  contractVersion: Schema.Literal(PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION),
  managerId: PiBackgroundTerminalManagerId,
  sequence: PositiveInt,
  timestamp: IsoDateTime,
} as const;

const PiBackgroundTerminalUpsertEvent = Schema.Struct({
  ...PiBackgroundTerminalEventBase,
  kind: Schema.Literal("terminal_upsert"),
  terminalId: PiBackgroundTerminalId,
  view: PiBackgroundTerminalView,
}).check(
  Schema.makeFilter(
    (event) => event.terminalId === event.view.id || "terminalId must match the upsert view id",
  ),
);

const PiBackgroundTerminalOutputEvent = Schema.Struct({
  ...PiBackgroundTerminalEventBase,
  kind: Schema.Literal("terminal_output"),
  terminalId: PiBackgroundTerminalId,
  output: PiBackgroundTerminalOutputDelta,
}).check(
  Schema.makeFilter(
    (event) =>
      event.terminalId === event.output.terminalId ||
      "terminalId must match the output terminal id",
  ),
);

export const PiBackgroundTerminalEvent = Schema.Union([
  PiBackgroundTerminalUpsertEvent,
  PiBackgroundTerminalOutputEvent,
  Schema.Struct({
    ...PiBackgroundTerminalEventBase,
    kind: Schema.Literal("terminal_removed"),
    terminalId: PiBackgroundTerminalId,
  }),
  Schema.Struct({
    ...PiBackgroundTerminalEventBase,
    kind: Schema.Literal("control_result"),
    control: PiBackgroundTerminalControlResult,
  }),
  Schema.Struct({
    ...PiBackgroundTerminalEventBase,
    kind: Schema.Literal("snapshot"),
    snapshot: PiBackgroundTerminalSnapshot,
  }),
]);
export type PiBackgroundTerminalEvent = typeof PiBackgroundTerminalEvent.Type;

const PiBackgroundTerminalControlBase = {
  threadId: ThreadId,
  requestId: Schema.optional(PiBackgroundTerminalRequestId),
} as const;

/** The only supported controls are extension-owned replay and kill actions. */
export const PiBackgroundTerminalControlInput = Schema.Union([
  Schema.Struct({
    ...PiBackgroundTerminalControlBase,
    action: Schema.Literal("replay"),
  }),
  Schema.Struct({
    ...PiBackgroundTerminalControlBase,
    action: Schema.Literal("kill"),
    terminalId: PiBackgroundTerminalId,
  }),
]);
export type PiBackgroundTerminalControlInput = typeof PiBackgroundTerminalControlInput.Type;

export const PiBackgroundTerminalSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type PiBackgroundTerminalSubscribeInput = typeof PiBackgroundTerminalSubscribeInput.Type;

export class PiBackgroundTerminalControlError extends Schema.TaggedErrorClass<PiBackgroundTerminalControlError>()(
  "PiBackgroundTerminalControlError",
  { message: Schema.String },
) {}
