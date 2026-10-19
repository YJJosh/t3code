// @effect-diagnostics nodeBuiltinImport:off - header-derived paths are a pure, synchronous format hook.
/** Dulli/Pi native history, including legacy Tau and persisted subagent sessions. */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { DulliSettings } from "../settings.ts";
import { resolvePiAgentDir } from "./piPaths.ts";

const DulliScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  projectPath: Schema.mutableKey(Schema.String),
  provider: Schema.mutableKey(Schema.String),
  model: Schema.mutableKey(Schema.String),
});
type DulliScanState = typeof DulliScanState.Type;

function parseRecord(parsed: unknown, state: DulliScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const entry = parsed as Record<string, unknown>;
  if (entry["type"] === "session") {
    if (typeof entry["id"] === "string") state.sessionId = entry["id"];
    if (typeof entry["cwd"] === "string") state.projectPath = entry["cwd"];
    return null;
  }
  if (entry["type"] === "model_change") {
    if (typeof entry["provider"] === "string") state.provider = entry["provider"];
    if (typeof entry["modelId"] === "string") state.model = entry["modelId"];
    return null;
  }

  if (entry["type"] === "usage") {
    if (typeof entry["provider"] === "string") state.provider = entry["provider"];
    if (typeof entry["model"] === "string") state.model = entry["model"];
  }
  let usage: unknown = entry["usage"];
  if (entry["type"] === "message") {
    const nestedMessage = entry["message"];
    const messageRecord =
      typeof nestedMessage === "object" && nestedMessage !== null
        ? (nestedMessage as Record<string, unknown>)
        : entry;
    const role = messageRecord["role"];
    if (role !== "assistant" && role !== "toolResult") return null;
    if (role === "assistant") {
      if (typeof messageRecord["provider"] === "string") state.provider = messageRecord["provider"];
      if (typeof messageRecord["model"] === "string") state.model = messageRecord["model"];
      if (typeof messageRecord["responseModel"] === "string")
        state.model = messageRecord["responseModel"];
    }
    usage = messageRecord["usage"];
  } else if (
    entry["type"] !== "compaction" &&
    entry["type"] !== "branch_summary" &&
    entry["type"] !== "usage"
  ) {
    return null;
  }

  if (typeof usage !== "object" || usage === null || state.model.length === 0) return null;
  const usageRecord = usage as Record<string, unknown>;
  const timestampMs = parseTimestampMs(entry["timestamp"]);
  if (timestampMs === null) return null;

  const totals = {
    uncachedInputTokens: tokenCount(usageRecord["input"]),
    cachedInputTokens: tokenCount(usageRecord["cacheRead"]),
    cacheCreationTokens: tokenCount(usageRecord["cacheWrite"]),
    outputTokens: tokenCount(usageRecord["output"]),
    // Pi folds reasoning into output; clamp so it never exceeds the total it is a subset of.
    reasoningTokens: Math.min(
      tokenCount(usageRecord["output"]),
      tokenCount(usageRecord["reasoning"]),
    ),
  };
  if (totalTokens(totals) === 0) return null;

  const cost = usageRecord["cost"];
  const totalCost =
    typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>)["total"] : null;
  return {
    provider: "dulli",
    speed: "standard",
    timestampMs,
    // Pi models are provider-scoped; qualify with the provider when known so
    // two providers' same-named models never collapse into one row.
    model: state.provider.length > 0 ? `${state.provider}/${state.model}` : state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: typeof totalCost === "number" && Number.isFinite(totalCost) ? totalCost : null,
    // Pi copies prior entries (including their ids) into forked sessions. The
    // entry id is therefore the durable cross-file identity; branch siblings
    // have their own ids and remain correctly counted as separate API calls.
    dedupeKey: typeof entry["id"] === "string" ? `pi:${entry["id"]}` : null,
  };
}

export const dulliUsageFormat: TranscriptUsageFormat<DulliScanState> = {
  // Upstream Pi reads the same native files. Dulli owns overlapping roots.
  sourceFamily: "pi",
  sourcePriority: 1,
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    cwd: true,
    provider: true,
    model: true,
    modelId: true,
    role: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"', '"model_change"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    const record = parseRecord(parsed, state);
    return record === null ? [] : [record];
  },
  parseProjected: (parsed, state) => {
    const record = parseRecord(parsed, state);
    return record === null ? [] : [record];
  },
  state: {
    initial: () => ({ sessionId: "", projectPath: "", provider: "", model: "" }),
    schema: DulliScanState,
  },
  directoriesFromState: (state) => {
    if (!NodePath.isAbsolute(state.projectPath)) return [];
    const roots = [];
    let directory = state.projectPath;
    // A project may be a deeply nested worktree. Never walk unbounded ancestors.
    for (let depth = 0; depth < 32; depth++) {
      roots.push({
        dir: NodePath.join(directory, ".pi-subagents", "runs"),
        maxDepth: 2,
        filePattern: "pi-subagent-session" as const,
      });
      const parent = NodePath.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return roots;
  },
};

export const dulliUsageReader: ProviderUsageReader<DulliSettings, Path.Path> = {
  kind: "transcripts",
  provider: "dulli",
  format: dulliUsageFormat,
  directories: Effect.fn("dulliUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const hostHome = yield* HostProcess.HomeDirectory;
    const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || hostHome;
    const agentDir = path.resolve(
      resolvePiAgentDir(path, {
        agentDir: config?.agentDir,
        environment: { ...environment, HOME: home },
      }),
    );
    const sessionOverride =
      environment.PI_CODING_AGENT_SESSION_DIR?.trim() ||
      environment.TAU_CODING_AGENT_SESSION_DIR?.trim();
    return [
      {
        dir: sessionOverride
          ? path.resolve(expandHomePath(sessionOverride, home))
          : path.join(agentDir, "sessions"),
        maxDepth: 1,
      },
      { dir: agentDir, maxDepth: 0 },
      {
        dir: path.join(agentDir, ".pi-subagents", "runs"),
        maxDepth: 2,
        filePattern: "pi-subagent-session" as const,
      },
    ];
  }),
};
