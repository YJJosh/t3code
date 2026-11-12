import {
  OrchestratorMcpFailure,
  TERMINAL_MCP_DEFAULT_READ_BYTES,
  TERMINAL_MCP_DEFAULT_WAIT_MS,
  TerminalMcpFailure,
  type TerminalAttachStreamEvent,
  type TerminalMcpCloseInput,
  type TerminalMcpCloseResult,
  type TerminalMcpListResult,
  type TerminalMcpReadInput,
  type TerminalMcpReadResult,
  type TerminalMcpSendInput,
  type TerminalMcpSendResult,
  type TerminalMcpStartInput,
  type TerminalMcpStartResult,
  type TerminalMcpWaitOutcome,
  type TerminalSessionStatus,
  type TerminalSummary,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { PlainTextTranscript } from "../terminal/PlainTextTranscript.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

type Failure = TerminalMcpFailure | OrchestratorMcpFailure;

export class TerminalMcpService extends Context.Service<
  TerminalMcpService,
  {
    readonly start: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpStartInput,
    ) => Effect.Effect<TerminalMcpStartResult, Failure>;
    readonly send: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpSendInput,
    ) => Effect.Effect<TerminalMcpSendResult, Failure>;
    readonly read: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpReadInput,
    ) => Effect.Effect<TerminalMcpReadResult, Failure>;
    readonly list: (scope: McpThreadInvocationScope) => Effect.Effect<TerminalMcpListResult>;
    readonly close: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpCloseInput,
    ) => Effect.Effect<TerminalMcpCloseResult, Failure>;
  }
>()("t3/mcp/TerminalMcpService") {}

const AGENT_TERMINAL_PREFIX = "agent-";
const MAX_RUNNING_AGENT_TERMINALS = 8;
const DEFAULT_QUIET_MS = 2_000;
const SHELL_READY_QUIET = Duration.seconds(1);
const SHELL_READY_LIMIT = Duration.seconds(5);
const BRACKETED_PASTE_ON = "\x1b[?2004h";

interface Tracker {
  readonly transcript: PlainTextTranscript;
  /** Replaced on every change, so a waiter awaits the next one. */
  changed: Deferred.Deferred<void>;
  readonly lineEditorReady: Deferred.Deferred<void>;
  status: TerminalSessionStatus;
  exitCode: number | null;
  stop: () => void;
}

const failure = (code: TerminalMcpFailure["code"], message: string) =>
  new TerminalMcpFailure({ code, message });

const notFound = (terminalId: string) =>
  failure("terminal_not_found", `No terminal \`${terminalId}\` in this thread. See terminal_list.`);

const userHasControl = (terminalId: string) =>
  failure(
    "user_has_control",
    `The user has control of terminal \`${terminalId}\`. Reading still works; ask the user to choose Give to agent before sending input.`,
  );

const terminalFailure =
  (terminalId: string) =>
  (error: TerminalManager.TerminalError | TerminalManager.TerminalControlledByUserError) => {
    switch (error._tag) {
      case "TerminalSessionLookupError":
        return notFound(terminalId);
      case "TerminalNotRunningError":
        return failure("not_running", `Terminal \`${terminalId}\` is not running.`);
      case "TerminalControlledByUserError":
        return userHasControl(terminalId);
      default:
        return failure("operation_failed", error.message);
    }
  };

export const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager.TerminalManager;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const trackers = new Map<string, Tracker>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const tracker of trackers.values()) tracker.stop();
      trackers.clear();
    }),
  );

  const trackerKey = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

  const summaryOf = (threadId: string, terminalId: string) =>
    terminals
      .listThread(threadId)
      .pipe(
        Effect.map((all) =>
          Option.fromNullishOr(all.find((terminal) => terminal.terminalId === terminalId)),
        ),
      );

  const requireSummary = Effect.fnUntraced(function* (threadId: string, terminalId: string) {
    const summary = yield* summaryOf(threadId, terminalId);
    if (Option.isNone(summary)) return yield* notFound(terminalId);
    return summary.value;
  });

  const signal = Effect.fnUntraced(function* (tracker: Tracker) {
    const previous = tracker.changed;
    tracker.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });

  const onEvent = Effect.fnUntraced(function* (
    key: string,
    tracker: Tracker,
    event: TerminalAttachStreamEvent,
  ) {
    switch (event.type) {
      case "snapshot":
      case "restarted":
        tracker.transcript.break();
        tracker.transcript.append(event.snapshot.history);
        tracker.status = event.snapshot.status;
        tracker.exitCode = event.snapshot.exitCode;
        if (event.snapshot.history.includes(BRACKETED_PASTE_ON)) {
          yield* Deferred.succeed(tracker.lineEditorReady, undefined);
        }
        break;
      case "output":
        tracker.transcript.append(event.data);
        if (event.data.includes(BRACKETED_PASTE_ON)) {
          yield* Deferred.succeed(tracker.lineEditorReady, undefined);
        }
        break;
      case "exited":
        tracker.status = "exited";
        tracker.exitCode = event.exitCode;
        break;
      case "error":
        tracker.status = "error";
        break;
      case "closed":
        tracker.status = "exited";
        tracker.stop();
        if (trackers.get(key) === tracker) trackers.delete(key);
        break;
      case "cleared":
      case "activity":
        return;
    }
    yield* signal(tracker);
  });

  /** Follows a terminal's output from its retained history on; kept until the terminal closes. */
  const trackerFor = Effect.fnUntraced(function* (threadId: string, terminalId: string) {
    const key = trackerKey(threadId, terminalId);
    const existing = trackers.get(key);
    if (existing) return existing;
    const tracker: Tracker = {
      transcript: new PlainTextTranscript(),
      changed: yield* Deferred.make<void>(),
      lineEditorReady: yield* Deferred.make<void>(),
      status: "starting",
      exitCode: null,
      stop: () => {},
    };
    trackers.set(key, tracker);
    const stop = yield* terminals
      .observeStream({ threadId, terminalId }, (event) => onEvent(key, tracker, event))
      .pipe(
        Effect.tapError(() => Effect.sync(() => trackers.delete(key))),
        Effect.mapError(terminalFailure(terminalId)),
      );
    tracker.stop = stop;
    return tracker;
  });

  const quietFor = Effect.fnUntraced(function* (tracker: Tracker, quiet: Duration.Input) {
    while (true) {
      const changed = yield* Deferred.await(tracker.changed).pipe(Effect.timeoutOption(quiet));
      if (Option.isNone(changed)) return;
    }
  });

  const ended = (tracker: Tracker) => tracker.status === "exited" || tracker.status === "error";

  const waitFor = Effect.fnUntraced(function* (
    tracker: Tracker,
    input: TerminalMcpReadInput,
  ): Effect.fn.Return<TerminalMcpWaitOutcome, TerminalMcpFailure> {
    const mode = input.waitFor;
    if (mode === undefined) return "none";
    let pattern: RegExp | null = null;
    if (mode === "match") {
      const source = input.pattern;
      if (source === undefined) {
        return yield* failure("invalid_request", "`waitFor: match` needs `pattern`.");
      }
      pattern = yield* Effect.try({
        try: () => new RegExp(source),
        catch: (cause) => failure("invalid_request", `Invalid pattern: ${String(cause)}`),
      });
    }
    const from = input.cursor ?? tracker.transcript.end;
    const wait = Effect.gen(function* () {
      if (mode === "quiet") {
        yield* quietFor(tracker, Duration.millis(input.quietMs ?? DEFAULT_QUIET_MS));
        return ended(tracker) ? ("exited" as const) : ("quiet" as const);
      }
      while (true) {
        const changed = tracker.changed;
        if (pattern !== null && pattern.test(tracker.transcript.textSince(from))) {
          return "matched" as const;
        }
        if (ended(tracker)) return "exited" as const;
        yield* Deferred.await(changed);
      }
    });
    const timeout = Duration.millis(input.timeoutMs ?? TERMINAL_MCP_DEFAULT_WAIT_MS);
    return yield* wait.pipe(
      Effect.timeoutOption(timeout),
      Effect.map(Option.getOrElse(() => "timeout" as const)),
    );
  });

  const requireFullAccess = Effect.fnUntraced(function* (
    scope: McpThreadInvocationScope,
    tool: string,
  ) {
    const shell = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    // Terminal input runs commands without the provider's approval prompts.
    if (shell.runtimeMode !== "full-access" || shell.interactionMode !== "default") {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `${tool} needs Full access. In this mode, run commands with your own shell tool so the user can approve them.`,
      });
    }
    return shell;
  });

  const requireAgentControl = Effect.fnUntraced(function* (summary: TerminalSummary) {
    if ((summary.controller ?? "user") !== "agent") {
      return yield* userHasControl(summary.terminalId);
    }
  });

  const start: TerminalMcpService["Service"]["start"] = Effect.fn("TerminalMcpService.start")(
    function* (scope, input) {
      const shell = yield* requireFullAccess(scope, "terminal_start");
      const threadId = scope.thread.threadId;
      const running = (yield* terminals.listThread(threadId)).filter(
        (terminal) =>
          terminal.terminalId.startsWith(AGENT_TERMINAL_PREFIX) && terminal.status === "running",
      );
      if (running.length >= MAX_RUNNING_AGENT_TERMINALS) {
        return yield* failure(
          "too_many_terminals",
          `This thread already runs ${running.length} agent terminals. Close one with terminal_close.`,
        );
      }
      const project = yield* projects.getById(shell.projectId).pipe(
        Effect.mapError(() => failure("operation_failed", "The project could not be read.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("operation_failed", "The project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const location = {
        project: { cwd: project.workspaceRoot },
        worktreePath: shell.worktreePath,
      };
      const cwd = projectScriptCwd(location);
      const terminalId = `${AGENT_TERMINAL_PREFIX}${(yield* random.uuidV4()).slice(0, 8)}`;
      yield* terminals
        .open(
          {
            threadId,
            terminalId,
            cwd,
            worktreePath: shell.worktreePath,
            // Before a client attaches, truecolor probes wait for replies nobody can send.
            env: { ...projectScriptRuntimeEnv(location), COLORTERM: "" },
          },
          { controller: "agent", title: input.title ?? "Agent terminal" },
        )
        .pipe(Effect.mapError(terminalFailure(terminalId)));
      const tracker = yield* trackerFor(threadId, terminalId);
      if (input.command !== undefined) {
        // Input typed while an rc file still runs can be swallowed, so wait for the shell first.
        yield* Effect.raceFirst(
          Deferred.await(tracker.lineEditorReady),
          quietFor(tracker, SHELL_READY_QUIET),
        ).pipe(Effect.timeoutOption(SHELL_READY_LIMIT));
      }
      const cursor = tracker.transcript.end;
      if (input.command !== undefined && !ended(tracker)) {
        yield* terminals
          .writeAsAgent({ threadId, terminalId, data: `${input.command}\r` })
          .pipe(Effect.mapError(terminalFailure(terminalId)));
      }
      return { terminalId, cwd, cursor };
    },
  );

  const send: TerminalMcpService["Service"]["send"] = Effect.fn("TerminalMcpService.send")(
    function* (scope, input) {
      yield* requireFullAccess(scope, "terminal_send");
      const threadId = scope.thread.threadId;
      const summary = yield* requireSummary(threadId, input.terminalId);
      yield* requireAgentControl(summary);
      if (summary.status !== "running") {
        return yield* failure("not_running", `Terminal \`${input.terminalId}\` is not running.`);
      }
      const tracker = yield* trackerFor(threadId, input.terminalId);
      const cursor = tracker.transcript.end;
      yield* terminals
        .writeAsAgent({ threadId, terminalId: input.terminalId, data: input.data })
        .pipe(Effect.mapError(terminalFailure(input.terminalId)));
      return { cursor };
    },
  );

  const read: TerminalMcpService["Service"]["read"] = Effect.fn("TerminalMcpService.read")(
    function* (scope, input) {
      const threadId = scope.thread.threadId;
      const before = yield* requireSummary(threadId, input.terminalId);
      const tracker = yield* trackerFor(threadId, input.terminalId);
      const waited = yield* waitFor(tracker, input);
      // A terminal closed during the wait has no summary left; its last output still reads.
      const after = yield* summaryOf(threadId, input.terminalId);
      const output = tracker.transcript.read(
        input.cursor,
        input.maxBytes ?? TERMINAL_MCP_DEFAULT_READ_BYTES,
      );
      return {
        ...output,
        status: Option.isSome(after) ? after.value.status : "exited",
        exitCode: Option.isSome(after) ? after.value.exitCode : tracker.exitCode,
        controller: (Option.isSome(after) ? after.value : before).controller ?? "user",
        waited,
      };
    },
  );

  const list: TerminalMcpService["Service"]["list"] = Effect.fn("TerminalMcpService.list")(
    function* (scope) {
      const all = yield* terminals.listThread(scope.thread.threadId);
      return {
        terminals: all.map((terminal) => ({
          terminalId: terminal.terminalId,
          title: terminal.label,
          cwd: terminal.cwd,
          status: terminal.status,
          exitCode: terminal.exitCode,
          controller: terminal.controller ?? "user",
          busy: terminal.hasRunningSubprocess,
        })),
      };
    },
  );

  const close: TerminalMcpService["Service"]["close"] = Effect.fn("TerminalMcpService.close")(
    function* (scope, input) {
      yield* requireFullAccess(scope, "terminal_close");
      const threadId = scope.thread.threadId;
      const summary = yield* requireSummary(threadId, input.terminalId);
      yield* requireAgentControl(summary);
      yield* terminals
        .close({ threadId, terminalId: input.terminalId, deleteHistory: true })
        .pipe(Effect.mapError(terminalFailure(input.terminalId)));
      return { closed: true as const };
    },
  );

  return TerminalMcpService.of({ start, send, read, list, close });
});

export const layer = Layer.effect(TerminalMcpService, make);
