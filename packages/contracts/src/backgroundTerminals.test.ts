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
    expect(decodeControl({ threadId, action: "kill", terminalId: "bt-1" })).toMatchObject({
      action: "kill",
    });
    expect(() => decodeControl({ threadId, action: "kill" })).toThrow();
    expect(() => decodeControl({ threadId, action: "kill", terminalId: "terminal-1" })).toThrow();
  });
});
