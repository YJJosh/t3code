import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Version of the Pi background-terminal extension event envelope. */
export const DULLI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION = 1 as const;
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_SNAPSHOT_TERMINALS = 32;

export const DulliBackgroundTerminalId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^bt-[1-9][0-9]*$/),
);
export type DulliBackgroundTerminalId = typeof DulliBackgroundTerminalId.Type;
const DulliBackgroundTerminalRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const DulliBackgroundTerminalManagerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
);
export type DulliBackgroundTerminalManagerId = typeof DulliBackgroundTerminalManagerId.Type;

export const DulliBackgroundTerminalStatus = Schema.Literals([
  "running",
  "done",
  "failed",
  "killed",
]);
export type DulliBackgroundTerminalStatus = typeof DulliBackgroundTerminalStatus.Type;

export const DulliBackgroundTerminalOutputView = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS)),
  totalBytes: NonNegativeInt,
  truncatedBytes: NonNegativeInt,
});
export type DulliBackgroundTerminalOutputView = typeof DulliBackgroundTerminalOutputView.Type;

const TerminalCols = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 500 }));
const TerminalRows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));
const TerminalClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Printable cells and locally generated SGR only; never terminal queries or OSC/DCS. */
export const DulliBackgroundTerminalScreen = Schema.Struct({
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
export type DulliBackgroundTerminalScreen = typeof DulliBackgroundTerminalScreen.Type;

export const DulliBackgroundTerminalView = Schema.Struct({
  id: DulliBackgroundTerminalId,
  command: Schema.String.check(Schema.isMaxLength(16_384)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  cwd: Schema.String.check(Schema.isMaxLength(4_096)),
  pid: Schema.optional(PositiveInt),
  status: DulliBackgroundTerminalStatus,
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
  stdout: DulliBackgroundTerminalOutputView,
  stderr: DulliBackgroundTerminalOutputView,
});
export type DulliBackgroundTerminalView = typeof DulliBackgroundTerminalView.Type;

export const DulliBackgroundTerminalEventKind = Schema.Literals([
  "terminal_upsert",
  "terminal_output",
  "terminal_screen",
  "terminal_removed",
  "control_result",
  "snapshot",
]);
export type DulliBackgroundTerminalEventKind = typeof DulliBackgroundTerminalEventKind.Type;

export const DulliBackgroundTerminalOutputDelta = Schema.Struct({
  terminalId: DulliBackgroundTerminalId,
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS)),
  replace: Schema.Boolean,
  totalBytes: NonNegativeInt,
  truncatedBytes: NonNegativeInt,
});
export type DulliBackgroundTerminalOutputDelta = typeof DulliBackgroundTerminalOutputDelta.Type;

export const DulliBackgroundTerminalControlAction = Schema.Literals([
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
export type DulliBackgroundTerminalControlAction = typeof DulliBackgroundTerminalControlAction.Type;

export const DulliBackgroundTerminalControlResult = Schema.Struct({
  requestId: Schema.optional(DulliBackgroundTerminalRequestId),
  action: DulliBackgroundTerminalControlAction,
  success: Schema.Boolean,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  /** Successful `start` results name the terminal that was created. */
  terminalId: Schema.optional(DulliBackgroundTerminalId),
});
export type DulliBackgroundTerminalControlResult = typeof DulliBackgroundTerminalControlResult.Type;

export const DulliBackgroundTerminalSnapshot = Schema.Struct({
  terminals: Schema.Array(DulliBackgroundTerminalView).check(
    Schema.isMaxLength(MAX_SNAPSHOT_TERMINALS),
  ),
  requestId: Schema.optional(DulliBackgroundTerminalRequestId),
  replay: Schema.optional(Schema.Boolean),
});
export type DulliBackgroundTerminalSnapshot = typeof DulliBackgroundTerminalSnapshot.Type;

const DulliBackgroundTerminalEventBase = {
  contractVersion: Schema.Literal(DULLI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION),
  managerId: DulliBackgroundTerminalManagerId,
  sequence: PositiveInt,
  timestamp: IsoDateTime,
} as const;

const DulliBackgroundTerminalUpsertEvent = Schema.Struct({
  ...DulliBackgroundTerminalEventBase,
  kind: Schema.Literal("terminal_upsert"),
  terminalId: DulliBackgroundTerminalId,
  view: DulliBackgroundTerminalView,
}).check(
  Schema.makeFilter(
    (event) => event.terminalId === event.view.id || "terminalId must match the upsert view id",
  ),
);

const DulliBackgroundTerminalOutputEvent = Schema.Struct({
  ...DulliBackgroundTerminalEventBase,
  kind: Schema.Literal("terminal_output"),
  terminalId: DulliBackgroundTerminalId,
  output: DulliBackgroundTerminalOutputDelta,
}).check(
  Schema.makeFilter(
    (event) =>
      event.terminalId === event.output.terminalId ||
      "terminalId must match the output terminal id",
  ),
);

export const DulliBackgroundTerminalEvent = Schema.Union([
  DulliBackgroundTerminalUpsertEvent,
  DulliBackgroundTerminalOutputEvent,
  Schema.Struct({
    ...DulliBackgroundTerminalEventBase,
    kind: Schema.Literal("terminal_screen"),
    terminalId: DulliBackgroundTerminalId,
    screen: DulliBackgroundTerminalScreen,
  }),
  Schema.Struct({
    ...DulliBackgroundTerminalEventBase,
    kind: Schema.Literal("terminal_removed"),
    terminalId: DulliBackgroundTerminalId,
  }),
  Schema.Struct({
    ...DulliBackgroundTerminalEventBase,
    kind: Schema.Literal("control_result"),
    control: DulliBackgroundTerminalControlResult,
  }),
  Schema.Struct({
    ...DulliBackgroundTerminalEventBase,
    kind: Schema.Literal("snapshot"),
    snapshot: DulliBackgroundTerminalSnapshot,
  }),
]);
export type DulliBackgroundTerminalEvent = typeof DulliBackgroundTerminalEvent.Type;

const DulliBackgroundTerminalControlBase = {
  threadId: ThreadId,
  requestId: Schema.optional(DulliBackgroundTerminalRequestId),
} as const;

const InteractiveControlBase = {
  ...DulliBackgroundTerminalControlBase,
  terminalId: DulliBackgroundTerminalId,
  managerId: DulliBackgroundTerminalManagerId,
  clientId: TerminalClientId,
} as const;

/** All controls use the extension's private command; process epochs guard reused ids. */
export const DulliBackgroundTerminalControlInput = Schema.Union([
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
    ...DulliBackgroundTerminalControlBase,
    action: Schema.Literal("start"),
    /** Process epoch of the live Pi session the terminal starts in (its cwd). */
    managerId: DulliBackgroundTerminalManagerId,
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    interactive: Schema.optional(Schema.Boolean),
    keepOpen: Schema.optional(Schema.Boolean),
    cols: Schema.optional(TerminalCols),
    rows: Schema.optional(TerminalRows),
  }),
  Schema.Struct({
    ...DulliBackgroundTerminalControlBase,
    action: Schema.Literal("replay"),
  }),
  Schema.Struct({
    ...DulliBackgroundTerminalControlBase,
    action: Schema.Literal("kill"),
    terminalId: DulliBackgroundTerminalId,
    /** Process epoch shown by the client; prevents stale rows from killing a reused terminal id. */
    managerId: DulliBackgroundTerminalManagerId,
  }),
]);
export type DulliBackgroundTerminalControlInput = typeof DulliBackgroundTerminalControlInput.Type;

export const DulliBackgroundTerminalSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type DulliBackgroundTerminalSubscribeInput =
  typeof DulliBackgroundTerminalSubscribeInput.Type;

export class DulliBackgroundTerminalControlError extends Schema.TaggedError<DulliBackgroundTerminalControlError>()(
  "DulliBackgroundTerminalControlError",
  { message: Schema.String },
) {}
