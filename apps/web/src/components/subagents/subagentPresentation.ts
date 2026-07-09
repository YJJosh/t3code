import type { SubagentActivityEntry } from "@t3tools/client-runtime/state/subagents";
import type { PiSubagentRunStatus, PiSubagentUsage } from "@t3tools/contracts";

export type SubagentStatusTone = "info" | "warning" | "success" | "error";

const STATUS_LABELS: Record<PiSubagentRunStatus, string> = {
  spawning: "Spawning",
  running: "Running",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
  killed: "Killed",
  interrupted: "Interrupted",
};

const STATUS_TONES: Record<PiSubagentRunStatus, SubagentStatusTone> = {
  spawning: "info",
  running: "info",
  needs_input: "warning",
  done: "success",
  failed: "error",
  killed: "error",
  interrupted: "error",
};

export function subagentStatusLabel(status: PiSubagentRunStatus): string {
  return STATUS_LABELS[status];
}

export function subagentStatusTone(status: PiSubagentRunStatus): SubagentStatusTone {
  return STATUS_TONES[status];
}

/** Short, human title for a run row: prefer the task text, fall back to run id. */
export function subagentRunTitle(task: string, runId: string): string {
  const trimmed = task.trim();
  return trimmed.length > 0 ? trimmed : runId;
}

const ACTIVITY_TEXT_KEYS = [
  "text",
  "message",
  "summary",
  "content",
  "note",
  "output",
  "result",
  "error",
] as const;
const ACTIVITY_NAME_KEYS = ["name", "tool", "toolName", "tool_name", "title", "label"] as const;
const ACTIVITY_DETAIL_KEYS = ["args", "arguments", "input", "result", "output", "error"] as const;
const MAX_ACTIVITY_SUMMARY_LENGTH = 4_000;

function compactActivityText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= MAX_ACTIVITY_SUMMARY_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_ACTIVITY_SUMMARY_LENGTH)}…`;
}

function firstStringField(
  data: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") {
      const compact = compactActivityText(value);
      if (compact !== null) {
        return compact;
      }
    }
  }
  return null;
}

/**
 * Pi's completed RPC events usually nest readable content under shapes such as
 * `message.content[].text` or `result.content[].text`. Walk only the known
 * human-facing fields so transcript rows show the actual child output without
 * dumping unrelated event metadata.
 */
function nestedActivityText(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return compactActivityText(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => nestedActivityText(entry, depth + 1))
      .filter((entry): entry is string => entry !== null);
    return parts.length > 0 ? compactActivityText(parts.join("\n")) : null;
  }
  if (typeof value !== "object") {
    return null;
  }

  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ACTIVITY_TEXT_KEYS) {
    if (key in record) {
      const text = nestedActivityText(record[key], depth + 1);
      if (text !== null) {
        return text;
      }
    }
  }
  return null;
}

function structuredActivityDetail(data: Readonly<Record<string, unknown>>): string | null {
  for (const key of ACTIVITY_DETAIL_KEYS) {
    const value = data[key];
    if (value === undefined) {
      continue;
    }
    const nested = nestedActivityText(value);
    if (nested !== null) {
      return nested;
    }
    if (typeof value === "object" && value !== null) {
      try {
        const encoded = compactActivityText(JSON.stringify(value));
        if (encoded !== null && encoded !== "{}" && encoded !== "[]") {
          return encoded;
        }
      } catch {
        // Activity is contract-validated as JSON-safe; retain a defensive
        // fallback in case a future in-memory caller violates that boundary.
      }
    }
  }
  return null;
}

/**
 * Collapse a structured child-activity entry into a single readable line for
 * the transcript. Kept provider-event-driven: no assumptions beyond the generic
 * `{ type, data }` shape the contract guarantees.
 */
export function summarizeSubagentActivity(entry: SubagentActivityEntry): string {
  const name = firstStringField(entry.data, ACTIVITY_NAME_KEYS);
  const directText = firstStringField(entry.data, ACTIVITY_TEXT_KEYS);
  const text = directText ?? nestedActivityText(entry.data) ?? structuredActivityDetail(entry.data);
  if (name !== null && text !== null && name !== text) {
    return `${name}: ${text}`;
  }
  return name ?? text ?? entry.type;
}

export function formatSubagentTokens(usage: PiSubagentUsage): string {
  return `${usage.total.toLocaleString()} tokens`;
}

export function formatSubagentCost(usage: PiSubagentUsage): string {
  return `$${usage.cost_estimate_usd.toFixed(2)}`;
}

export function formatSubagentActiveMs(activeMs: number): string {
  if (activeMs < 1000) {
    return `${Math.round(activeMs)}ms`;
  }
  const seconds = activeMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}
