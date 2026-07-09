import type {
  SubagentActivityEntry,
  SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type {
  OrchestrationThreadShell,
  PiSubagentRunStatus,
  PiSubagentUsage,
  ServerConfig,
} from "@t3tools/contracts";

export const MAX_VISIBLE_CHILD_ACTIVITY = 100;

const STATUS_LABELS: Record<PiSubagentRunStatus, string> = {
  spawning: "Spawning",
  running: "Running",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
  killed: "Killed",
  interrupted: "Interrupted",
};

export type MobileSubagentStatusTone = "info" | "warning" | "success" | "error";

const STATUS_TONES: Record<PiSubagentRunStatus, MobileSubagentStatusTone> = {
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

export function subagentStatusTone(status: PiSubagentRunStatus): MobileSubagentStatusTone {
  return STATUS_TONES[status];
}

export function subagentRunTitle(task: string, runId: string): string {
  return task.trim() || runId;
}

/**
 * Resolve the provider that owns this thread rather than the composer's draft
 * selection. A live session is authoritative; otherwise use the persisted
 * model selection. Legacy snapshots may identify the built-in directly as pi.
 */
export function threadSupportsPiSubagents(
  thread: {
    readonly modelSelection: Pick<OrchestrationThreadShell["modelSelection"], "instanceId">;
    readonly session: Pick<
      NonNullable<OrchestrationThreadShell["session"]>,
      "providerInstanceId" | "providerName"
    > | null;
  },
  serverConfig: Pick<ServerConfig, "providers"> | null,
): boolean {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const provider = serverConfig?.providers.find((entry) => entry.instanceId === instanceId);

  if (provider !== undefined) {
    return String(provider.driver) === "pi";
  }

  return String(instanceId) === "pi" || thread.session?.providerName === "pi";
}

export function formatSubagentActiveMs(activeMs: number): string {
  if (activeMs < 1_000) return `${Math.round(activeMs)}ms`;
  const seconds = activeMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatSubagentTokens(usage: PiSubagentUsage): string {
  return `${usage.total.toLocaleString()} tokens`;
}

export function formatSubagentCost(usage: PiSubagentUsage): string {
  return `$${usage.cost_estimate_usd.toFixed(2)}`;
}

const READABLE_KEYS = [
  "text",
  "message",
  "summary",
  "content",
  "note",
  "output",
  "result",
  "error",
] as const;
const NAME_KEYS = ["name", "tool", "toolName", "tool_name", "title", "label"] as const;
const DETAIL_KEYS = ["args", "arguments", "input", "result", "output", "error"] as const;
const MAX_ACTIVITY_TEXT_LENGTH = 1_000;

function compactText(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return text.length > MAX_ACTIVITY_TEXT_LENGTH
    ? `${text.slice(0, MAX_ACTIVITY_TEXT_LENGTH)}…`
    : text;
}

function readableValue(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") return compactText(value);
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => readableValue(item, depth + 1))
      .filter((item): item is string => item !== null);
    return lines.length > 0 ? compactText(lines.join("\n")) : null;
  }
  if (typeof value !== "object") return null;

  const record = value as Readonly<Record<string, unknown>>;
  for (const key of READABLE_KEYS) {
    const text = readableValue(record[key], depth + 1);
    if (text !== null) return text;
  }
  return null;
}

function firstString(
  data: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") {
      const text = compactText(value);
      if (text !== null) return text;
    }
  }
  return null;
}

function structuredDetail(data: Readonly<Record<string, unknown>>): string | null {
  for (const key of DETAIL_KEYS) {
    const value = data[key];
    if (value === undefined) continue;
    const readable = readableValue(value);
    if (readable !== null) return readable;
    if (typeof value === "object" && value !== null) {
      try {
        const encoded = compactText(JSON.stringify(value));
        if (encoded !== null && encoded !== "{}" && encoded !== "[]") return encoded;
      } catch {
        // The contract guarantees JSON-safe data; keep the transcript usable
        // if a future in-memory caller violates that boundary.
      }
    }
  }
  return null;
}

export function summarizeSubagentActivity(entry: SubagentActivityEntry): string {
  const name = firstString(entry.data, NAME_KEYS);
  const text = readableValue(entry.data) ?? structuredDetail(entry.data);
  if (name !== null && text !== null && name !== text) return `${name}: ${text}`;
  return name ?? text ?? entry.type;
}

/** The shared reducer is bounded at ingestion; mobile applies a tighter render cap. */
export function selectVisibleSubagentActivity(
  run: SubagentRunEntry,
): ReadonlyArray<SubagentActivityEntry> {
  return run.activity.slice(-MAX_VISIBLE_CHILD_ACTIVITY);
}
