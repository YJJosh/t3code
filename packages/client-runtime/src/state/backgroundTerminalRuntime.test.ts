import { describe, expect, it } from "vite-plus/test";

import type {
  PiBackgroundTerminalEvent,
  PiBackgroundTerminalOutputView,
  PiBackgroundTerminalStatus,
  PiBackgroundTerminalView,
} from "@t3tools/contracts";

import {
  applyBackgroundTerminalEvent,
  DEFAULT_MAX_BACKGROUND_TERMINAL_OUTPUT_BYTES,
  EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
  hasBackgroundTerminals,
  isBackgroundTerminalActive,
  isBackgroundTerminalOutputTruncated,
  isBackgroundTerminalTerminal,
  selectActiveBackgroundTerminals,
  selectBackgroundTerminal,
  selectBackgroundTerminalControlResult,
  selectBackgroundTerminals,
  trimToUtf8ByteBudget,
  type BackgroundTerminalRuntimeState,
} from "./backgroundTerminalRuntime.ts";

function outputView(
  text: string,
  overrides: Partial<PiBackgroundTerminalOutputView> = {},
): PiBackgroundTerminalOutputView {
  return {
    text,
    totalBytes: text.length,
    truncatedBytes: 0,
    ...overrides,
  };
}

const EMPTY_OUTPUT = outputView("");

function view(
  overrides: Partial<PiBackgroundTerminalView> & { id: string },
): PiBackgroundTerminalView {
  return {
    command: "npm run build",
    title: `Terminal ${overrides.id}`,
    cwd: "/workspace",
    status: "running",
    createdAt: 1_774_992_000_000,
    stdout: EMPTY_OUTPUT,
    stderr: EMPTY_OUTPUT,
    ...overrides,
  };
}

function event(
  overrides: Partial<PiBackgroundTerminalEvent> & { sequence: number },
): PiBackgroundTerminalEvent {
  return {
    managerId: "manager-1",
    timestamp: `2026-04-01T00:00:${String(overrides.sequence).padStart(2, "0")}.000Z`,
    kind: "terminal_upsert",
    ...overrides,
  } as PiBackgroundTerminalEvent;
}

describe("trimToUtf8ByteBudget", () => {
  it("keeps text unchanged when within the byte budget", () => {
    const result = trimToUtf8ByteBudget("hello", 10);
    expect(result).toEqual({ text: "hello", trimmedBytes: 0 });
  });

  it("trims from the front to the byte budget, keeping the tail", () => {
    const result = trimToUtf8ByteBudget("abcdefgh", 4);
    expect(result).toEqual({ text: "efgh", trimmedBytes: 4 });
  });

  it("never splits a multi-byte UTF-8 sequence", () => {
    // "é" is 2 bytes (0xC3 0xA9); cutting at byte budget 1 would land mid-sequence.
    const text = "aé";
    const result = trimToUtf8ByteBudget(text, 1);
    // The leading continuation byte is skipped rather than emitting invalid text.
    expect(result.text).toBe("");
    expect(result.trimmedBytes).toBe(3);
  });

  it("drops everything when the budget is zero", () => {
    const result = trimToUtf8ByteBudget("hello", 0);
    expect(result).toEqual({ text: "", trimmedBytes: 5 });
  });
});

describe("applyBackgroundTerminalEvent", () => {
  it("creates a terminal from a terminal_upsert event carrying a view", () => {
    const next = applyBackgroundTerminalEvent(
      EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "terminal_upsert",
        view: view({ id: "term-a", status: "running" }),
      }),
    );

    expect(hasBackgroundTerminals(next)).toBe(true);
    expect(next.managerId).toBe("manager-1");
    const terminal = selectBackgroundTerminal(next, "term-a");
    expect(terminal?.view.status).toBe("running");
    expect(next.version).toBe(1);
  });

  it("ignores duplicate and stale sequences for a manager", () => {
    const created = applyBackgroundTerminalEvent(
      EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      event({ sequence: 5, view: view({ id: "term-a", status: "running" }) }),
    );

    const duplicate = applyBackgroundTerminalEvent(
      created,
      event({ sequence: 5, view: view({ id: "term-a", status: "failed" }) }),
    );
    expect(duplicate).toBe(created);

    const stale = applyBackgroundTerminalEvent(
      created,
      event({ sequence: 3, view: view({ id: "term-a", status: "failed" }) }),
    );
    expect(stale).toBe(created);
    expect(selectBackgroundTerminal(created, "term-a")?.view.status).toBe("running");
  });

  it("dedupes per manager, not globally", () => {
    const first = applyBackgroundTerminalEvent(
      EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      event({ sequence: 10, managerId: "manager-1", view: view({ id: "term-a" }) }),
    );
    const second = applyBackgroundTerminalEvent(
      first,
      event({ sequence: 2, managerId: "manager-2", view: view({ id: "term-b" }) }),
    );
    expect(selectBackgroundTerminals(second)).toHaveLength(2);
    expect(second.managerSequences.get("manager-1")).toBe(10);
    expect(second.managerSequences.get("manager-2")).toBe(2);
  });

  it("removes a terminal on terminal_removed", () => {
    const created = applyBackgroundTerminalEvent(
      EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      event({ sequence: 1, view: view({ id: "term-a" }) }),
    );
    const removed = applyBackgroundTerminalEvent(
      created,
      event({ sequence: 2, kind: "terminal_removed", terminalId: "term-a" }),
    );
    expect(hasBackgroundTerminals(removed)).toBe(false);
    expect(selectBackgroundTerminal(removed, "term-a")).toBeNull();
  });

  it("records control results keyed by requestId", () => {
    const next = applyBackgroundTerminalEvent(
      EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "control_result",
        control: { requestId: "req-1", action: "kill", success: true },
      }),
    );
    expect(selectBackgroundTerminalControlResult(next, "req-1")?.success).toBe(true);
    expect(selectBackgroundTerminalControlResult(next, "missing")).toBeNull();
  });

  it("bounds control results to the configured limit", () => {
    let state: BackgroundTerminalRuntimeState = EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE;
    for (let index = 0; index < 5; index += 1) {
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: index + 1,
          kind: "control_result",
          control: { requestId: `req-${index}`, action: "kill", success: true },
        }),
        { maxControlResults: 2 },
      );
    }
    expect(state.controlResults).toHaveLength(2);
    expect(state.controlResults.map((entry) => entry.requestId)).toEqual(["req-3", "req-4"]);
  });

  describe("terminal_output deltas", () => {
    it("appends output for a known terminal", () => {
      let state = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, view: view({ id: "term-a" }) }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 2,
          kind: "terminal_output",
          terminalId: "term-a",
          output: {
            terminalId: "term-a",
            stream: "stdout",
            text: "hello ",
            replace: false,
            totalBytes: 6,
            truncatedBytes: 0,
          },
        }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 3,
          kind: "terminal_output",
          terminalId: "term-a",
          output: {
            terminalId: "term-a",
            stream: "stdout",
            text: "world",
            replace: false,
            totalBytes: 11,
            truncatedBytes: 0,
          },
        }),
      );

      const terminal = selectBackgroundTerminal(state, "term-a");
      expect(terminal?.stdout.text).toBe("hello world");
      expect(terminal?.stdout.totalBytes).toBe(11);
      expect(terminal?.stderr.text).toBe("");
    });

    it("replaces output when the delta requests replace", () => {
      let state = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, view: view({ id: "term-a" }) }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 2,
          kind: "terminal_output",
          terminalId: "term-a",
          output: {
            terminalId: "term-a",
            stream: "stderr",
            text: "stale",
            replace: false,
            totalBytes: 5,
            truncatedBytes: 0,
          },
        }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 3,
          kind: "terminal_output",
          terminalId: "term-a",
          output: {
            terminalId: "term-a",
            stream: "stderr",
            text: "fresh",
            replace: true,
            totalBytes: 5,
            truncatedBytes: 0,
          },
        }),
      );

      expect(selectBackgroundTerminal(state, "term-a")?.stderr.text).toBe("fresh");
    });

    it("preserves a longer accumulated tail when a settlement upsert carries its suffix", () => {
      let state = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, view: view({ id: "term-a" }) }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 2,
          kind: "terminal_output",
          terminalId: "term-a",
          output: {
            terminalId: "term-a",
            stream: "stdout",
            text: "hello world",
            replace: false,
            totalBytes: 11,
            truncatedBytes: 0,
          },
        }),
      );
      state = applyBackgroundTerminalEvent(
        state,
        event({
          sequence: 3,
          kind: "terminal_upsert",
          view: view({
            id: "term-a",
            status: "done",
            settledAt: 1_774_992_001_000,
            stdout: outputView("world", { totalBytes: 11, truncatedBytes: 6 }),
          }),
        }),
      );

      const terminal = selectBackgroundTerminal(state, "term-a");
      expect(terminal?.view.status).toBe("done");
      expect(terminal?.stdout.text).toBe("hello world");
      expect(terminal?.stdout.truncatedBytes).toBe(0);
      expect(terminal?.stdout.clientTruncatedBytes).toBe(0);
      expect(isBackgroundTerminalOutputTruncated(terminal!.stdout)).toBe(false);
    });

    it("keeps output bounded to the configured client byte budget", () => {
      let state = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, view: view({ id: "term-a" }) }),
      );
      for (let index = 0; index < 5; index += 1) {
        state = applyBackgroundTerminalEvent(
          state,
          event({
            sequence: index + 2,
            kind: "terminal_output",
            terminalId: "term-a",
            output: {
              terminalId: "term-a",
              stream: "stdout",
              text: "abcde",
              replace: false,
              totalBytes: (index + 1) * 5,
              truncatedBytes: 0,
            },
          }),
          { maxOutputBytes: 8 },
        );
      }
      const terminal = selectBackgroundTerminal(state, "term-a");
      expect(terminal?.stdout.text.length).toBeLessThanOrEqual(8);
      expect(terminal?.stdout.text).toBe(
        "abcdeabcdeabcdeabcdeabcde".slice("abcdeabcdeabcdeabcdeabcde".length - 8),
      );
      expect(terminal?.stdout.clientTruncatedBytes).toBeGreaterThan(0);
      expect(isBackgroundTerminalOutputTruncated(terminal!.stdout)).toBe(true);
    });

    it("reports truncation from server-side counts even without client trimming", () => {
      const state = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({
          sequence: 1,
          view: view({
            id: "term-a",
            stdout: outputView("recent output", { totalBytes: 5_000, truncatedBytes: 4_900 }),
          }),
        }),
      );
      const terminal = selectBackgroundTerminal(state, "term-a");
      expect(isBackgroundTerminalOutputTruncated(terminal!.stdout)).toBe(true);
      expect(terminal?.stdout.text).toBe("recent output");
    });

    it("drops output for a terminal whose view has not been seen", () => {
      const next = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({
          sequence: 1,
          kind: "terminal_output",
          terminalId: "unknown",
          output: {
            terminalId: "unknown",
            stream: "stdout",
            text: "hello",
            replace: false,
            totalBytes: 5,
            truncatedBytes: 0,
          },
        }),
      );
      expect(hasBackgroundTerminals(next)).toBe(false);
    });
  });

  describe("snapshots", () => {
    it("rebuilds the terminal set authoritatively from a snapshot", () => {
      const primed = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, view: view({ id: "stale" }) }),
      );

      const snapshotEvent = event({
        sequence: 20,
        kind: "snapshot",
        snapshot: {
          terminals: [view({ id: "term-a", status: "failed", stdout: outputView("build failed") })],
        },
      });

      const rebuilt = applyBackgroundTerminalEvent(primed, snapshotEvent);
      expect(selectBackgroundTerminal(rebuilt, "stale")).toBeNull();
      const terminal = selectBackgroundTerminal(rebuilt, "term-a");
      expect(terminal?.view.status).toBe("failed");
      expect(terminal?.stdout.text).toBe("build failed");
      expect(rebuilt.managerSequences.get("manager-1")).toBe(20);
    });

    it("clears all terminals when a new manager sends an empty snapshot", () => {
      const primed = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 1, managerId: "manager-old", view: view({ id: "term-a" }) }),
      );
      expect(hasBackgroundTerminals(primed)).toBe(true);

      const reconnected = applyBackgroundTerminalEvent(
        primed,
        event({
          sequence: 1,
          managerId: "manager-new",
          kind: "snapshot",
          snapshot: { terminals: [] },
        }),
      );

      expect(hasBackgroundTerminals(reconnected)).toBe(false);
      expect(reconnected.managerId).toBe("manager-new");
    });

    it("ignores a stale snapshot that arrives after newer live state", () => {
      const current = applyBackgroundTerminalEvent(
        EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
        event({ sequence: 21, view: view({ id: "term-a", status: "failed" }) }),
      );

      const staleSnapshot = event({
        sequence: 20,
        kind: "snapshot",
        snapshot: { terminals: [view({ id: "term-a", status: "running" })] },
      });
      const afterStaleSnapshot = applyBackgroundTerminalEvent(current, staleSnapshot);

      expect(afterStaleSnapshot).toBe(current);
      expect(selectBackgroundTerminal(afterStaleSnapshot, "term-a")?.view.status).toBe("failed");
    });
  });

  it("separates active from terminal terminals", () => {
    let state: BackgroundTerminalRuntimeState = EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE;
    state = applyBackgroundTerminalEvent(
      state,
      event({ sequence: 1, view: view({ id: "term-a", status: "running" }) }),
    );
    state = applyBackgroundTerminalEvent(
      state,
      event({ sequence: 2, view: view({ id: "term-b", status: "done" }) }),
    );
    const active = selectActiveBackgroundTerminals(state);
    expect(active.map((entry) => entry.view.id)).toEqual(["term-a"]);
  });
});

describe("background terminal status predicates", () => {
  const cases: ReadonlyArray<[PiBackgroundTerminalStatus, boolean]> = [
    ["running", true],
    ["done", false],
    ["failed", false],
    ["killed", false],
  ];
  for (const [status, active] of cases) {
    it(`classifies ${status}`, () => {
      expect(isBackgroundTerminalActive(status)).toBe(active);
      expect(isBackgroundTerminalTerminal(status)).toBe(!active);
    });
  }
});

it("exposes the default client byte budget for output retention", () => {
  expect(DEFAULT_MAX_BACKGROUND_TERMINAL_OUTPUT_BYTES).toBe(256 * 1024);
});
