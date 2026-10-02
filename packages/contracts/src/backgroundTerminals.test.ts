import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PiBackgroundTerminalControlInput,
  PiBackgroundTerminalEvent,
  PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION,
} from "./backgroundTerminals.ts";
import { PiBackgroundTerminalEvent as ExportedPiBackgroundTerminalEvent } from "./index.ts";

const decodeEvent = Schema.decodeUnknownSync(PiBackgroundTerminalEvent);
const decodeControl = Schema.decodeUnknownSync(PiBackgroundTerminalControlInput);

const terminal = {
  id: "bt-1",
  command: "pnpm dev",
  title: "Dev server",
  cwd: "/repo",
  pid: 123,
  status: "running",
  createdAt: 1_752_067_200_000,
  stdout: { text: "ready", totalBytes: 5, truncatedBytes: 0 },
  stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
} as const;

describe("PiBackgroundTerminalEvent", () => {
  it("is exported from the public contracts entrypoint", () => {
    expect(ExportedPiBackgroundTerminalEvent).toBe(PiBackgroundTerminalEvent);
  });

  it("decodes the v1 snapshot envelope", () => {
    expect(
      decodeEvent({
        contractVersion: PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION,
        managerId: "pi-background-terminals:test",
        sequence: 1,
        timestamp: "2026-07-09T12:00:00.000Z",
        kind: "snapshot",
        snapshot: { terminals: [terminal], requestId: "replay-1", replay: true },
      }),
    ).toMatchObject({ kind: "snapshot", snapshot: { terminals: [terminal] } });
  });

  it("rejects semantically incomplete or mismatched envelopes", () => {
    const base = {
      contractVersion: 1,
      managerId: "pi-background-terminals:test",
      sequence: 2,
      timestamp: "2026-07-09T12:00:01.000Z",
    } as const;
    expect(() => decodeEvent({ ...base, kind: "snapshot" })).toThrow();
    expect(() =>
      decodeEvent({
        ...base,
        kind: "terminal_upsert",
        terminalId: "bt-2",
        view: terminal,
      }),
    ).toThrow();
    expect(() =>
      decodeEvent({
        ...base,
        kind: "terminal_output",
        terminalId: "bt-1",
        output: {
          terminalId: "bt-2",
          stream: "stdout",
          text: "next",
          replace: false,
          totalBytes: 9,
          truncatedBytes: 0,
        },
      }),
    ).toThrow();
  });

  it("decodes output updates without requiring a terminal view", () => {
    expect(
      decodeEvent({
        contractVersion: 1,
        managerId: "pi-background-terminals:test",
        sequence: 2,
        timestamp: "2026-07-09T12:00:01.000Z",
        kind: "terminal_output",
        terminalId: "bt-1",
        output: {
          terminalId: "bt-1",
          stream: "stdout",
          text: "next",
          replace: false,
          totalBytes: 9,
          truncatedBytes: 0,
        },
      }),
    ).toMatchObject({ kind: "terminal_output" });
  });
});

describe("PiBackgroundTerminalControlInput", () => {
  it("replays the authoritative full set and requires a valid terminal for kill", () => {
    const threadId = "11111111-1111-4111-8111-111111111111";
    expect(decodeControl({ threadId, action: "replay" })).toMatchObject({ action: "replay" });
    expect(decodeControl({ threadId, action: "replay", terminalId: "bt-1" })).not.toHaveProperty(
      "terminalId",
    );
    expect(
      decodeControl({
        threadId,
        action: "kill",
        terminalId: "bt-1",
        managerId: "pi-background-terminals:test",
      }),
    ).toMatchObject({ action: "kill", managerId: "pi-background-terminals:test" });
    expect(() => decodeControl({ threadId, action: "kill", terminalId: "bt-1" })).toThrow();
    expect(() =>
      decodeControl({
        threadId,
        action: "kill",
        terminalId: "terminal-1",
        managerId: "pi-background-terminals:test",
      }),
    ).toThrow();
  });
});

it("decodes additive interactive metadata and safe bounded screen snapshots", () => {
  const base = {
    contractVersion: 1,
    managerId: "manager",
    sequence: 1,
    timestamp: "2026-07-09T12:00:00.000Z",
  };
  const view = {
    ...terminal,
    interactive: true,
    keepOpen: true,
    cols: 80,
    rows: 24,
    attached: true,
    controller: "tab",
  };
  expect(decodeEvent({ ...base, kind: "terminal_upsert", terminalId: "bt-1", view })).toMatchObject(
    { view },
  );
  const screen = {
    cols: 3,
    rows: 1,
    lines: ["\x1b[31mred\x1b[0m"],
    cursorX: 2,
    cursorY: 0,
    cursorVisible: true,
    applicationCursorKeysMode: true,
    bracketedPasteMode: true,
  };
  const event = { ...base, kind: "terminal_screen", terminalId: "bt-1", screen };
  expect(decodeEvent(event)).toMatchObject({ screen });
  for (const line of ["\x1b[6n", "\x1b]52;c;x\x07", "\x1bPbad\x1b\\", "\n", "\x9b6n"]) {
    expect(() => decodeEvent({ ...event, screen: { ...screen, lines: [line] } })).toThrow();
  }
  expect(() => decodeEvent({ ...event, screen: { ...screen, cursorX: 3 } })).toThrow();
  expect(() =>
    decodeEvent({ ...event, screen: { ...screen, lines: ["x".repeat(128 * 1024 + 1)] } }),
  ).toThrow();
});

it("requires process epoch and client ownership for new controls and bounds send/resize", () => {
  const base = { threadId: "thread", managerId: "manager", terminalId: "bt-1", clientId: "client" };
  for (const action of ["watch", "unwatch", "attach", "release"])
    expect(decodeControl({ ...base, action })).toMatchObject({ action });
  expect(decodeControl({ ...base, action: "send", data: "\x03\x1b[A\r" })).toMatchObject({
    data: "\x03\x1b[A\r",
  });
  expect(() => decodeControl({ ...base, action: "send", data: "😀".repeat(4097) })).toThrow();
  expect(() => decodeControl({ ...base, action: "resize", cols: 501, rows: 2 })).toThrow();
  expect(() => decodeControl({ ...base, action: "watch", managerId: undefined })).toThrow();
});
