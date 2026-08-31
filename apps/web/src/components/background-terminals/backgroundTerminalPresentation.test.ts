import type { BackgroundTerminalEntry } from "@t3tools/client-runtime/state/background-terminals";
import type { PiBackgroundTerminalStatus, PiBackgroundTerminalView } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundTerminalAccessibleStatus,
  backgroundTerminalElapsedLabel,
  backgroundTerminalExitSummary,
  backgroundTerminalRosterSummaryLabel,
  backgroundTerminalStatusLabel,
  backgroundTerminalStatusTone,
  backgroundTerminalTitle,
  backgroundTerminalTruncatedBytes,
  formatBytes,
  groupBackgroundTerminalsForRoster,
  isBackgroundTerminalQuiet,
  sanitizeTerminalOutputText,
} from "./backgroundTerminalPresentation";

const EMPTY_OUTPUT = { text: "", totalBytes: 0, truncatedBytes: 0 } as const;

function view(
  overrides: Partial<PiBackgroundTerminalView> & { id: string },
): PiBackgroundTerminalView {
  return {
    command: "npm run build",
    title: "",
    cwd: "/workspace",
    status: "running",
    createdAt: Date.parse("2026-04-01T00:00:00.000Z"),
    stdout: EMPTY_OUTPUT,
    stderr: EMPTY_OUTPUT,
    ...overrides,
  };
}

function entry(
  overrides: Partial<PiBackgroundTerminalView> & { id: string },
): BackgroundTerminalEntry {
  return {
    view: view(overrides),
    stdout: { text: "", totalBytes: 0, truncatedBytes: 0, clientTruncatedBytes: 0 },
    stderr: { text: "", totalBytes: 0, truncatedBytes: 0, clientTruncatedBytes: 0 },
    lastSequence: 1,
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("backgroundTerminalStatusLabel / tone", () => {
  const cases: ReadonlyArray<PiBackgroundTerminalStatus> = ["running", "done", "failed", "killed"];
  for (const status of cases) {
    it(`has a label and tone for ${status}`, () => {
      expect(backgroundTerminalStatusLabel(status).length).toBeGreaterThan(0);
      expect(["info", "warning", "success", "error"]).toContain(
        backgroundTerminalStatusTone(status),
      );
    });
  }

  it("only done/killed are quiet", () => {
    expect(isBackgroundTerminalQuiet("running")).toBe(false);
    expect(isBackgroundTerminalQuiet("failed")).toBe(false);
    expect(isBackgroundTerminalQuiet("done")).toBe(true);
    expect(isBackgroundTerminalQuiet("killed")).toBe(true);
  });

  it("calls out failed in the accessible status", () => {
    expect(backgroundTerminalAccessibleStatus("failed")).toContain("needs your attention");
    expect(backgroundTerminalAccessibleStatus("running")).toBe("Running");
  });
});

describe("backgroundTerminalTitle", () => {
  it("prefers the title, then the command, then the id", () => {
    expect(backgroundTerminalTitle(view({ id: "term-a", title: "Build" }))).toBe("Build");
    expect(backgroundTerminalTitle(view({ id: "term-a", title: "", command: "npm test" }))).toBe(
      "npm test",
    );
    expect(backgroundTerminalTitle(view({ id: "term-a", title: "", command: "" }))).toBe("term-a");
  });
});

describe("groupBackgroundTerminalsForRoster", () => {
  it("keeps running/failed in attention and done/killed in quiet", () => {
    const running = entry({ id: "a", status: "running" });
    const failed = entry({ id: "b", status: "failed" });
    const done = entry({ id: "c", status: "done" });
    const killed = entry({ id: "d", status: "killed" });

    const { attention, quiet } = groupBackgroundTerminalsForRoster([running, failed, done, killed]);
    expect(attention.map((item) => item.view.id)).toEqual(["a", "b"]);
    expect(quiet.map((item) => item.view.id)).toEqual(["c", "d"]);
  });
});

describe("backgroundTerminalRosterSummaryLabel", () => {
  it("pluralizes correctly", () => {
    expect(backgroundTerminalRosterSummaryLabel(1)).toBe("1 settled terminal");
    expect(backgroundTerminalRosterSummaryLabel(3)).toBe("3 settled terminals");
  });
});

describe("backgroundTerminalElapsedLabel", () => {
  it("uses settledAt as the end time once settled", () => {
    const settled = view({
      id: "a",
      createdAt: Date.parse("2026-04-01T00:00:00.000Z"),
      settledAt: Date.parse("2026-04-01T00:01:00.000Z"),
    });
    // now is far in the future; elapsed must still be pinned to settledAt.
    const label = backgroundTerminalElapsedLabel(
      settled,
      new Date("2026-04-01T01:00:00.000Z").getTime(),
    );
    expect(label).toBe("1m");
  });

  it("uses now as the end time while still running", () => {
    const running = view({
      id: "a",
      createdAt: Date.parse("2026-04-01T00:00:00.000Z"),
    });
    const label = backgroundTerminalElapsedLabel(
      running,
      new Date("2026-04-01T00:00:30.000Z").getTime(),
    );
    expect(label).toBe("30s");
  });
});

describe("backgroundTerminalExitSummary", () => {
  it("prefers errorText, then signal, then exit code", () => {
    expect(backgroundTerminalExitSummary(view({ id: "a", errorText: "spawn ENOENT" }))).toBe(
      "spawn ENOENT",
    );
    expect(backgroundTerminalExitSummary(view({ id: "a", signal: "SIGTERM" }))).toBe(
      "Signal SIGTERM",
    );
    expect(backgroundTerminalExitSummary(view({ id: "a", exitCode: 1 }))).toBe("Exit code 1");
    expect(backgroundTerminalExitSummary(view({ id: "a" }))).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("backgroundTerminalTruncatedBytes", () => {
  it("adds disjoint bridge and browser retention losses", () => {
    expect(
      backgroundTerminalTruncatedBytes({
        text: "",
        totalBytes: 0,
        truncatedBytes: 10,
        clientTruncatedBytes: 5,
      }),
    ).toBe(15);
  });
});

describe("sanitizeTerminalOutputText", () => {
  // Built from character codes (not embedded literally) so this test file
  // never carries a raw ESC/BEL byte in its source.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  it("strips ANSI CSI color, cursor, and private-mode sequences", () => {
    const raw = `${ESC}[?25l${ESC}[31mError:${ESC}[0m something failed${ESC}[?25h`;
    expect(sanitizeTerminalOutputText(raw)).toBe("Error: something failed");
  });

  it("strips ANSI OSC title-change sequences terminated by BEL", () => {
    const raw = `${ESC}]0;my title${BEL}after`;
    expect(sanitizeTerminalOutputText(raw)).toBe("after");
  });

  it("strips ANSI OSC sequences terminated by an ST (ESC backslash)", () => {
    const raw = `${ESC}]0;my title${ESC}\\after`;
    expect(sanitizeTerminalOutputText(raw)).toBe("after");
  });

  it("does not swallow content after a mixed CSI/OSC sequence", () => {
    const raw = `${ESC}[1;33mColored${ESC}[0m${ESC}]0;title${BEL}END`;
    expect(sanitizeTerminalOutputText(raw)).toBe("ColoredEND");
  });

  it("keeps tabs, newlines, and carriage returns but drops other control characters", () => {
    const raw = `line1\tindented\nline2\rcarriage${String.fromCharCode(1)} end`;
    expect(sanitizeTerminalOutputText(raw)).toBe("line1\tindented\nline2\rcarriage end");
  });

  it("leaves plain text untouched", () => {
    const raw = "Build succeeded in 4.2s";
    expect(sanitizeTerminalOutputText(raw)).toBe(raw);
  });
});
