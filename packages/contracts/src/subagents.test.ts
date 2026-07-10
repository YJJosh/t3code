import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PiSubagentControlInput,
  PiSubagentEvent,
  PI_SUBAGENT_EVENT_CONTRACT_VERSION,
} from "./subagents.ts";

const decodeEvent = Schema.decodeUnknownSync(PiSubagentEvent);
const decodeControl = Schema.decodeUnknownSync(PiSubagentControlInput);

const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 0,
  total: 6,
  turns: 1,
  cost_estimate_usd: 0.01,
};

const run = {
  runId: "rmre1dz89-9",
  task: "Review the provider",
  model: "provider/model",
  state: "running" as const,
  directory: "/repo",
  skills: [],
  turns: 1,
  activeMs: 100,
  usageSoFar: usage,
  openQuestions: [],
  checkAfterTokens: 1000,
  nextCheckTokens: 2000,
  managerCheckPending: false,
};

describe("PiSubagentEvent", () => {
  it("decodes live events and reconnect snapshots with durable replay", () => {
    const replay = {
      contractVersion: PI_SUBAGENT_EVENT_CONTRACT_VERSION,
      managerId: "pi-subagents:manager",
      sequence: 1,
      timestamp: "2026-07-09T12:00:00.000Z",
      kind: "run_running" as const,
      runId: run.runId,
      view: run,
      replay: true,
    };
    const snapshot = decodeEvent({
      contractVersion: PI_SUBAGENT_EVENT_CONTRACT_VERSION,
      managerId: "pi-subagents:manager",
      sequence: 2,
      timestamp: "2026-07-09T12:00:01.000Z",
      kind: "snapshot",
      snapshot: { runs: [run], events: [replay], requestId: "reconnect", replay: true },
    });
    expect(snapshot.snapshot?.events?.[0]?.sequence).toBe(1);
    expect(snapshot.snapshot?.runs[0]?.runId).toBe(run.runId);
  });

  it("rejects unsupported contract versions", () => {
    expect(() =>
      decodeEvent({
        contractVersion: 2,
        managerId: "pi-subagents:manager",
        sequence: 1,
        timestamp: "2026-07-09T12:00:00.000Z",
        kind: "snapshot",
      }),
    ).toThrow();
  });
});

describe("PiSubagentControlInput", () => {
  it("requires action-specific message and reason fields", () => {
    expect(
      decodeControl({
        threadId: "thread-1",
        action: "steer",
        runId: "rmre1dz89-9",
        message: "Focus on lifecycle cleanup",
      }).action,
    ).toBe("steer");
    expect(() =>
      decodeControl({ threadId: "thread-1", action: "kill", runId: "rmre1dz89-9" }),
    ).toThrow();
  });
});
