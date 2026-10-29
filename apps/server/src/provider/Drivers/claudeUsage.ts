import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * T3 Code writes one record per assistant *content block*, and every one of those records repeats
 * the same complete `usage` object for the parent message. Summing them overcounts by roughly
 * 2.4x on a real workload, so the caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(
  line: string,
  state = initialClaudeScanState(),
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed, state);
}

const ClaudeScanState = Schema.Struct({
  piDriven: Schema.mutableKey(Schema.Boolean),
});
type ClaudeScanState = typeof ClaudeScanState.Type;

const initialClaudeScanState = (): ClaudeScanState => ({ piDriven: false });

// Pi's claude-agent-sdk extension always appends this note, in both replay modes. Pi records
// the same usage in its own session, which the Dulli reader counts, so these files are skipped.
const PI_REPLAY_NOTE = "## Conversation replay\nPi ";
// Claude Code versions before `prompt_snapshot` only show Pi through its text replay, which
// opens the first prompt with this exact block.
const PI_REPLAY_FIRST_BLOCK = "USER:\n";

function isPiDrivenMarker(record: Record<string, unknown>): boolean {
  if (record["type"] === "attachment") {
    const attachment = record["attachment"];
    if (typeof attachment !== "object" || attachment === null) return false;
    const systemPrompt = (attachment as Record<string, unknown>)["systemPrompt"];
    const parts = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
    return parts.some((part) => typeof part === "string" && part.includes(PI_REPLAY_NOTE));
  }
  if (record["type"] === "user") {
    const message = record["message"];
    if (typeof message !== "object" || message === null) return false;
    const content = (message as Record<string, unknown>)["content"];
    const first: unknown = Array.isArray(content) ? content[0] : undefined;
    return (
      typeof first === "object" &&
      first !== null &&
      (first as Record<string, unknown>)["text"] === PI_REPLAY_FIRST_BLOCK
    );
  }
  return false;
}

function parseClaudeRecord(parsed: unknown, state: ClaudeScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null || state.piDriven) return null;

  const record = parsed as Record<string, unknown>;
  if (isPiDrivenMarker(record)) {
    state.piDriven = true;
    return null;
  }
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const claudeUsageFormat: TranscriptUsageFormat<ClaudeScanState> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    attachment: { systemPrompt: true },
    // The first block's text keeps Pi's `USER:` replay marker on streamed lines.
    message: { id: true, model: true, usage: true, content: { 0: { text: true } } },
  },
  usageMarkers: ['"usage"', '"prompt_snapshot"', `"text":${JSON.stringify(PI_REPLAY_FIRST_BLOCK)}`],
  parseLine: (line, state) => orEmpty(parseClaudeLine(line, state)),
  parseProjected: (projected, state) => orEmpty(parseClaudeRecord(projected, state)),
  state: { initial: initialClaudeScanState, schema: ClaudeScanState },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.homePath.trim();
    const home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
