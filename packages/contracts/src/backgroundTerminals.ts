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
export const PiBackgroundTerminalManagerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PiBackgroundTerminalManagerId = typeof PiBackgroundTerminalManagerId.Type;

export const PiBackgroundTerminalStatus = Schema.Literals(["running", "done", "failed", "killed"]);
export type PiBackgroundTerminalStatus = typeof PiBackgroundTerminalStatus.Type;

export const PiBackgroundTerminalOutputView = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS)),
  totalBytes: NonNegativeInt,
  truncatedBytes: NonNegativeInt,
});
export type PiBackgroundTerminalOutputView = typeof PiBackgroundTerminalOutputView.Type;

const TerminalCols = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 500 }));
const TerminalRows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));
const TerminalClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Printable cells and locally generated SGR only; never terminal queries or OSC/DCS. */
export const PiBackgroundTerminalScreen = Schema.Struct({
  cols: TerminalCols,
  rows: TerminalRows,
  lines: Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(128 * 1024),
      // eslint-disable-next-line no-control-regex -- Reject every control except generated SGR.
      Schema.isPattern(/^(?:[^\x00-\x1f\x7f-\x9f]|\x1b\[[0-9;]*m)*$/u),
    ),
  ).check(Schema.isMaxLength(200)),
  cursorX: NonNegativeInt,
  cursorY: NonNegativeInt,
  cursorVisible: Schema.Boolean,
  applicationCursorKeysMode: Schema.Boolean,
  bracketedPasteMode: Schema.Boolean,
  warning: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
}).check(
  Schema.makeFilter(
    (screen) =>
      (screen.lines.length === screen.rows &&
        screen.cursorX < screen.cols &&
        screen.cursorY < screen.rows &&
        screen.lines.reduce((sum, line) => sum + line.length, 0) <= 128 * 1024) ||
      "Invalid or oversized terminal screen",
  ),
);
export type PiBackgroundTerminalScreen = typeof PiBackgroundTerminalScreen.Type;

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
  interactive: Schema.optional(Schema.Boolean),
  keepOpen: Schema.optional(Schema.Boolean),
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
  attached: Schema.optional(Schema.Boolean),
  controller: Schema.optional(TerminalClientId),
  stdout: PiBackgroundTerminalOutputView,
  stderr: PiBackgroundTerminalOutputView,
});
export type PiBackgroundTerminalView = typeof PiBackgroundTerminalView.Type;

export const PiBackgroundTerminalEventKind = Schema.Literals([
  "terminal_upsert",
  "terminal_output",
  "terminal_screen",
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

export const PiBackgroundTerminalControlAction = Schema.Literals([
  "replay",
  "kill",
  "watch",
  "unwatch",
  "attach",
  "release",
  "send",
  "resize",
  "start",
]);
export type PiBackgroundTerminalControlAction = typeof PiBackgroundTerminalControlAction.Type;

export const PiBackgroundTerminalControlResult = Schema.Struct({
  requestId: Schema.optional(PiBackgroundTerminalRequestId),
  action: PiBackgroundTerminalControlAction,
  success: Schema.Boolean,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  /** Successful `start` results name the terminal that was created. */
  terminalId: Schema.optional(PiBackgroundTerminalId),
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
    kind: Schema.Literal("terminal_screen"),
    terminalId: PiBackgroundTerminalId,
    screen: PiBackgroundTerminalScreen,
  }),
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

const InteractiveControlBase = {
  ...PiBackgroundTerminalControlBase,
  terminalId: PiBackgroundTerminalId,
  managerId: PiBackgroundTerminalManagerId,
  clientId: TerminalClientId,
} as const;

/** All controls use the extension's private command; process epochs guard reused ids. */
export const PiBackgroundTerminalControlInput = Schema.Union([
  Schema.Struct({
    ...InteractiveControlBase,
    action: Schema.Literals(["watch", "unwatch", "attach", "release"]),
  }),
  Schema.Struct({
    ...InteractiveControlBase,
    action: Schema.Literal("send"),
    data: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16 * 1024),
      Schema.makeFilter(
        (data) => new TextEncoder().encode(data).length <= 16 * 1024 || "Input exceeds 16 KiB",
      ),
    ),
  }),
  Schema.Struct({
    ...InteractiveControlBase,
    action: Schema.Literal("resize"),
    cols: TerminalCols,
    rows: TerminalRows,
  }),
  Schema.Struct({
    ...PiBackgroundTerminalControlBase,
    action: Schema.Literal("start"),
    /** Process epoch of the live Pi session the terminal starts in (its cwd). */
    managerId: PiBackgroundTerminalManagerId,
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    interactive: Schema.optional(Schema.Boolean),
    keepOpen: Schema.optional(Schema.Boolean),
    cols: Schema.optional(TerminalCols),
    rows: Schema.optional(TerminalRows),
  }),
  Schema.Struct({
    ...PiBackgroundTerminalControlBase,
    action: Schema.Literal("replay"),
  }),
  Schema.Struct({
    ...PiBackgroundTerminalControlBase,
    action: Schema.Literal("kill"),
    terminalId: PiBackgroundTerminalId,
    /** Process epoch shown by the client; prevents stale rows from killing a reused terminal id. */
    managerId: PiBackgroundTerminalManagerId,
  }),
]);
export type PiBackgroundTerminalControlInput = typeof PiBackgroundTerminalControlInput.Type;

export const PiBackgroundTerminalSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type PiBackgroundTerminalSubscribeInput = typeof PiBackgroundTerminalSubscribeInput.Type;

export class PiBackgroundTerminalControlError extends Schema.TaggedError<PiBackgroundTerminalControlError>()(
  "PiBackgroundTerminalControlError",
  { message: Schema.String },
) {}
