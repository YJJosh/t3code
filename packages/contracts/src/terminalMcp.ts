import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TerminalController, TerminalSessionStatus } from "./terminal.ts";

export const TERMINAL_MCP_MAX_WAIT_MS = 10 * 60 * 1_000;
export const TERMINAL_MCP_DEFAULT_WAIT_MS = 30_000;
export const TERMINAL_MCP_DEFAULT_READ_BYTES = 16 * 1024;
const TERMINAL_MCP_MAX_READ_BYTES = 64 * 1024;

const TerminalMcpId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const TerminalMcpCursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const TerminalMcpStartInput = Schema.Struct({
  command: Schema.optional(
    Schema.String.check(Schema.isNonEmpty())
      .check(Schema.isMaxLength(65_536))
      .annotate({ description: "Shell command to run once the shell is ready." }),
  ),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type TerminalMcpStartInput = typeof TerminalMcpStartInput.Type;

export const TerminalMcpStartResult = Schema.Struct({
  terminalId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  cursor: TerminalMcpCursor.annotate({ description: "Pass to `terminal_read` for new output." }),
});
export type TerminalMcpStartResult = typeof TerminalMcpStartResult.Type;

export const TerminalMcpSendInput = Schema.Struct({
  terminalId: TerminalMcpId,
  data: Schema.String.check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(65_536))
    .annotate({ description: "Raw input. `\\r` submits a line, `\\u0003` is Ctrl+C." }),
});
export type TerminalMcpSendInput = typeof TerminalMcpSendInput.Type;

export const TerminalMcpSendResult = Schema.Struct({
  cursor: TerminalMcpCursor.annotate({ description: "Output position before this input." }),
});
export type TerminalMcpSendResult = typeof TerminalMcpSendResult.Type;

export const TerminalMcpWaitFor = Schema.Literals(["match", "exit", "quiet"]);
export type TerminalMcpWaitFor = typeof TerminalMcpWaitFor.Type;

export const TerminalMcpReadInput = Schema.Struct({
  terminalId: TerminalMcpId,
  cursor: Schema.optional(
    TerminalMcpCursor.annotate({ description: "From an earlier result. Omitted: the tail." }),
  ),
  waitFor: Schema.optional(
    TerminalMcpWaitFor.annotate({
      description:
        "`match`: `pattern` matches output after `cursor`. `exit`: the shell ends. `quiet`: no output for `quietMs`.",
    }),
  ),
  pattern: Schema.optional(
    Schema.String.check(Schema.isNonEmpty())
      .check(Schema.isMaxLength(1_000))
      .annotate({ description: "JavaScript regex for `match`." }),
  ),
  quietMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100))
      .check(Schema.isLessThanOrEqualTo(60_000))
      .annotate({ description: "Default 2000." }),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(TERMINAL_MCP_MAX_WAIT_MS))
      .annotate({ description: "Wait limit. Default 30000, max 600000." }),
  ),
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(256))
      .check(Schema.isLessThanOrEqualTo(TERMINAL_MCP_MAX_READ_BYTES))
      .annotate({ description: "Default 16384. Longer output keeps its end." }),
  ),
});
export type TerminalMcpReadInput = typeof TerminalMcpReadInput.Type;

export const TerminalMcpWaitOutcome = Schema.Literals([
  "none",
  "matched",
  "exited",
  "quiet",
  "timeout",
]);
export type TerminalMcpWaitOutcome = typeof TerminalMcpWaitOutcome.Type;

export const TerminalMcpReadResult = Schema.Struct({
  text: Schema.String,
  cursor: TerminalMcpCursor,
  truncated: Schema.Boolean,
  status: TerminalSessionStatus,
  exitCode: Schema.NullOr(Schema.Int),
  controller: TerminalController,
  waited: TerminalMcpWaitOutcome,
});
export type TerminalMcpReadResult = typeof TerminalMcpReadResult.Type;

export const TerminalMcpTerminal = Schema.Struct({
  terminalId: TrimmedNonEmptyString,
  title: Schema.String,
  cwd: Schema.String,
  status: TerminalSessionStatus,
  exitCode: Schema.NullOr(Schema.Int),
  controller: TerminalController,
  busy: Schema.Boolean.annotate({ description: "A command is running in the shell." }),
});
export type TerminalMcpTerminal = typeof TerminalMcpTerminal.Type;

export const TerminalMcpListResult = Schema.Struct({
  terminals: Schema.Array(TerminalMcpTerminal),
});
export type TerminalMcpListResult = typeof TerminalMcpListResult.Type;

export const TerminalMcpCloseInput = Schema.Struct({
  terminalId: TerminalMcpId,
});
export type TerminalMcpCloseInput = typeof TerminalMcpCloseInput.Type;

export const TerminalMcpCloseResult = Schema.Struct({
  closed: Schema.Literal(true),
});
export type TerminalMcpCloseResult = typeof TerminalMcpCloseResult.Type;

export class TerminalMcpFailure extends Schema.TaggedError<TerminalMcpFailure>()(
  "TerminalMcpFailure",
  {
    code: Schema.Literals([
      "terminal_not_found",
      "user_has_control",
      "not_running",
      "invalid_request",
      "too_many_terminals",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
