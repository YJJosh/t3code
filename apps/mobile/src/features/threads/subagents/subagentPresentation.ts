import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type MobileSubagentStatusTone = "info" | "warning" | "success" | "error" | "muted";

const STATUS_LABELS: Record<RuntimeSubagentStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Needs input",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

const STATUS_TONES: Record<RuntimeSubagentStatus, MobileSubagentStatusTone> = {
  pending: "info",
  running: "info",
  waiting: "warning",
  idle: "muted",
  completed: "success",
  failed: "error",
  cancelled: "muted",
  interrupted: "muted",
};

export function subagentStatusLabel(status: RuntimeSubagentStatus): string {
  return STATUS_LABELS[status];
}

export function subagentStatusTone(status: RuntimeSubagentStatus): MobileSubagentStatusTone {
  return STATUS_TONES[status];
}

export function subagentRunTitle(agent: Pick<RuntimeSubagent, "id" | "title">): string {
  return agent.title.trim() || agent.id;
}

export function formatSubagentDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (startedAt === null) return "—";
  const start = Date.parse(startedAt);
  const end = completedAt === null ? Date.now() : Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
