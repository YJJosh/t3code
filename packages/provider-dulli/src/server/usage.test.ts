import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderInstanceId } from "@t3tools/contracts";
import { dulliUsageFormat, dulliUsageReader } from "./usage.ts";

const initialPiScanState = () => dulliUsageFormat.state!.initial();
const parsePiLine = (line: string, state: ReturnType<typeof initialPiScanState>) =>
  dulliUsageFormat.parseLine(line, state)[0] ?? null;

describe("parsePiLine", () => {
  const sessionHeader = JSON.stringify({
    type: "session",
    id: "pi-session-1",
    cwd: "/home/theo/project",
    timestamp: "2026-08-14T10:00:00.000Z",
  });
  const modelChange = JSON.stringify({
    type: "model_change",
    provider: "anthropic",
    modelId: "claude-fable-5",
    timestamp: "2026-08-14T10:00:01.000Z",
  });
  const assistantMessage = (
    usage: Record<string, unknown>,
    timestamp = "2026-08-14T10:00:05.000Z",
  ) =>
    JSON.stringify({
      type: "message",
      timestamp,
      message: { role: "assistant", usage },
    });

  it("carries session id and model forward onto usage-bearing messages", () => {
    const state = initialPiScanState();
    expect(parsePiLine(sessionHeader, state)).toBeNull();
    expect(parsePiLine(modelChange, state)).toBeNull();

    const record = parsePiLine(
      assistantMessage({
        input: 100,
        cacheRead: 20,
        cacheWrite: 5,
        output: 40,
        reasoning: 10,
        cost: { total: 0.42 },
      }),
      state,
    );

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("dulli");
    expect(record?.model).toBe("anthropic/claude-fable-5");
    expect(record?.sessionId).toBe("pi-session-1");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    expect(record?.reportedCostUsd).toBe(0.42);
    expect(record?.dedupeKey).toBeNull();
    expect(state.projectPath).toBe("/home/theo/project");
  });

  it("prefers the model declared inline on an assistant message", () => {
    const state = initialPiScanState();
    parsePiLine(sessionHeader, state);
    const record = parsePiLine(
      JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-08-14T10:00:05.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt-5.6", usage: { output: 12 } },
      }),
      state,
    );

    expect(record?.model).toBe("openai/gpt-5.6");
    expect(record?.dedupeKey).toBe("pi:message-1");
  });

  it("accepts historical flat message entries", () => {
    const state = initialPiScanState();
    parsePiLine(sessionHeader, state);
    const record = parsePiLine(
      JSON.stringify({
        type: "message",
        id: "flat-message",
        timestamp: "2026-08-14T10:00:05.000Z",
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6",
        usage: { input: 10, cacheRead: 20, output: 3 },
      }),
      state,
    );

    expect(record).toMatchObject({
      model: "openai/gpt-5.6",
      dedupeKey: "pi:flat-message",
      totals: { uncachedInputTokens: 10, cachedInputTokens: 20, outputTokens: 3 },
    });
  });

  it("drops usage lines until a model is known", () => {
    const state = initialPiScanState();
    parsePiLine(sessionHeader, state);
    // No model seen yet: a usage-bearing line cannot be attributed.
    expect(parsePiLine(assistantMessage({ output: 5 }), state)).toBeNull();
  });

  it("counts toolResult usage and drops zero-token and non-usage lines", () => {
    const state = initialPiScanState();
    parsePiLine(sessionHeader, state);
    parsePiLine(modelChange, state);

    const toolResult = parsePiLine(
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-14T10:00:06.000Z",
        message: { role: "toolResult", usage: { input: 7 } },
      }),
      state,
    );
    expect(toolResult?.totals.uncachedInputTokens).toBe(7);

    expect(parsePiLine(assistantMessage({ output: 0, input: 0 }), state)).toBeNull();
    expect(
      parsePiLine(JSON.stringify({ type: "message", message: { role: "user" } }), state),
    ).toBeNull();
  });

  it("ignores malformed Pi lines", () => {
    expect(parsePiLine("{not json", initialPiScanState())).toBeNull();
  });
});

describe("Dulli usage", () => {
  it("clamps reasoning, preserves native zero cost, and parses summaries", () => {
    const state = initialPiScanState();
    parsePiLine(JSON.stringify({ type: "model_change", provider: "a", modelId: "m" }), state);
    for (const type of ["compaction", "branch_summary"]) {
      expect(
        parsePiLine(
          JSON.stringify({
            type,
            id: type,
            timestamp: "2026-08-01T00:00:00Z",
            usage: { input: -1, output: 3.7, reasoning: 20, cost: { total: 0 } },
          }),
          state,
        ),
      ).toMatchObject({
        reportedCostUsd: 0,
        dedupeKey: `pi:${type}`,
        totals: { uncachedInputTokens: 0, outputTokens: 3, reasoningTokens: 3 },
      });
    }
  });

  it("derives only bounded child-session roots from absolute project headers", () => {
    const state = initialPiScanState();
    expect(dulliUsageFormat.directoriesFromState!(state)).toEqual([]);
    state.projectPath = "/projects/work/.worktrees/branch";
    const roots = dulliUsageFormat.directoriesFromState!(state);
    expect(roots[0]).toEqual({
      dir: "/projects/work/.worktrees/branch/.pi-subagents/runs",
      maxDepth: 2,
      filePattern: "pi-subagent-session",
    });
    expect(roots).toContainEqual({
      dir: "/projects/work/.pi-subagents/runs",
      maxDepth: 2,
      filePattern: "pi-subagent-session",
    });
    state.projectPath = "/" + Array.from({ length: 100 }, () => "deep").join("/");
    expect(dulliUsageFormat.directoriesFromState!(state)).toHaveLength(32);
  });

  it.effect("honors configured agent home, Pi/Tau session overrides and legacy roots", () =>
    Effect.gen(function* () {
      if (dulliUsageReader.kind !== "transcripts") throw new Error("expected transcripts");
      for (const [config, environment, agent, sessions] of [
        [undefined, {}, "/home/test/.pi/agent", "/home/test/.pi/agent/sessions"],
        [
          undefined,
          { HOME: "/instance-home" },
          "/instance-home/.pi/agent",
          "/instance-home/.pi/agent/sessions",
        ],
        [undefined, { TAU_CODING_AGENT_DIR: "~/tau" }, "/home/test/tau", "/home/test/tau/sessions"],
        [
          { agentDir: "~/configured" },
          { PI_CODING_AGENT_DIR: "~/ignored", TAU_CODING_AGENT_SESSION_DIR: "~/tau-sessions" },
          "/home/test/configured",
          "/home/test/tau-sessions",
        ],
        [
          undefined,
          {
            PI_CODING_AGENT_DIR: "~/pi",
            TAU_CODING_AGENT_DIR: "~/tau",
            PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions",
            TAU_CODING_AGENT_SESSION_DIR: "~/ignored",
          },
          "/home/test/pi",
          "/home/test/pi-sessions",
        ],
      ] as const) {
        const roots = yield* dulliUsageReader
          .directories({
            instanceId: ProviderInstanceId.make("dulli"),
            config: config as Parameters<typeof dulliUsageReader.directories>[0]["config"],
            environment,
            configured: true,
          })
          .pipe(
            Effect.provide(Path.layer),
            Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
          );
        expect(roots).toEqual([
          { dir: sessions, maxDepth: 1 },
          { dir: agent, maxDepth: 0 },
          { dir: `${agent}/.pi-subagents/runs`, maxDepth: 2, filePattern: "pi-subagent-session" },
        ]);
      }
    }),
  );
});
