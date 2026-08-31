import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

export const AGENT_STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-warning", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

export function AgentStatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATUS_VISUALS[status].dotClass)}
    />
  );
}

export function formatAgentElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function agentElapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatAgentElapsedSeconds((end - start) / 1000);
}

/** Live elapsed time uses DOM writes so the inspector does not rerender every second. */
export function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = agentElapsedBetween(startedAt, null);
    };
    update();
    const id = window.setInterval(update, 1_000);
    return () => window.clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) return null;
  return (
    <span ref={textRef} className="inline-flex items-center gap-1 tabular-nums">
      {agentElapsedBetween(startedAt, live ? null : agent.completedAt)}
      {agent.status === "completed" ? <Check aria-hidden className="size-3 text-success" /> : null}
    </span>
  );
}

export function preferredInspectorAgent(
  agents: ReadonlyArray<RuntimeSubagent>,
): RuntimeSubagent | null {
  return (
    agents.find((agent) => agent.kind !== "workflow" && agent.status === "waiting") ??
    agents.find(
      (agent) =>
        agent.kind !== "workflow" && (agent.status === "running" || agent.status === "pending"),
    ) ??
    agents.find((agent) => agent.kind !== "workflow" && agent.status === "failed") ??
    [...agents].toReversed().find((agent) => agent.kind !== "workflow") ??
    agents.at(-1) ??
    null
  );
}

export function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

export function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return !["completed", "failed", "cancelled", "interrupted"].includes(status);
}

export function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}
