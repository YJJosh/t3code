import type {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  projectedSubagentsToRuntime,
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "./subagentRuntime.ts";

export interface DulliInspectorAgent extends RuntimeSubagent {
  readonly prompt: string;
  readonly source: OrchestrationV2Subagent;
}
export interface DulliInspectorWorkflowGroup extends SubagentWorkflowGroup {
  readonly workflow: DulliInspectorAgent;
  readonly phases: ReadonlyArray<
    Omit<SubagentWorkflowGroup["phases"][number], "members"> & {
      readonly members: ReadonlyArray<DulliInspectorAgent>;
      readonly activeCount: number;
    }
  >;
  readonly unphasedMembers: ReadonlyArray<DulliInspectorAgent>;
}
export interface DulliRosterBatch {
  readonly id: string;
  readonly prompt: string;
  readonly directAgents: ReadonlyArray<DulliInspectorAgent>;
  readonly workflows: ReadonlyArray<DulliInspectorWorkflowGroup>;
}
export interface DulliPanelModel {
  readonly agents: ReadonlyArray<DulliInspectorAgent>;
  readonly directAgents: ReadonlyArray<DulliInspectorAgent>;
  readonly workflows: ReadonlyArray<DulliInspectorWorkflowGroup>;
  readonly batches: ReadonlyArray<DulliRosterBatch>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
}

export function formatSubagentModelLabel(model: string | null, effort: string | null) {
  return model ? (effort ? `${model} · ${effort}` : model) : null;
}
export function formatSubagentTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000)
    return `${tokens < 100_000 ? (tokens / 1000).toFixed(1) : Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Live progress wins over an earlier activation's result; settled rows show the outcome. */
export function agentActivityText(agent: RuntimeSubagent): string | null {
  const tool = agent.lastToolName ? `▸ ${agent.lastToolName}` : null;
  return isActiveSubagentStatus(agent.status)
    ? agent.progress || tool || agent.result || agent.error
    : agent.error || agent.result || agent.progress || tool;
}
export function workflowMembers(group: DulliInspectorWorkflowGroup) {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}
export function workflowStatus(group: DulliInspectorWorkflowGroup): RuntimeSubagent["status"] {
  const members = workflowMembers(group);
  const status = group.workflow.status;
  // REVIEW: Real Pi coordinators own their lifecycle (including gaps between phases
  // and waiting for input). Only weak, synthetic coordinators infer it from children.
  if (group.workflow.source.nativeTaskRef?.strength === "strong" || !members.length) return status;
  if (status === "failed" || members.some((agent) => agent.status === "failed")) return "failed";
  if (members.some((agent) => !isTerminalSubagentStatus(agent.status))) return "running";
  if (status === "cancelled" || status === "interrupted") return status;
  return members.some((agent) => agent.status === "cancelled" || agent.status === "interrupted")
    ? "cancelled"
    : "completed";
}
export function workflowIsLive(group: DulliInspectorWorkflowGroup): boolean {
  const members = workflowMembers(group);
  // REVIEW: Native coordinators remain live even when all retained children settled.
  if (group.workflow.source.nativeTaskRef?.strength === "strong")
    return !isTerminalSubagentStatus(group.workflow.status);
  return members.length
    ? members.some((agent) => !isTerminalSubagentStatus(agent.status))
    : !isTerminalSubagentStatus(group.workflow.status);
}

/** Dulli's inspector reads Pi-owned records, never legacy task activities. */
export function deriveDulliAgentInspector(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "dulliRuns" | "dulliTranscript" | "dulliTranscriptRevisions" | "messages"
  > & {
    readonly providerSessions: ReadonlyArray<
      Pick<
        OrchestrationV2ThreadProjection["providerSessions"][number],
        "providerInstanceId" | "status" | "updatedAt"
      >
    >;
  },
) {
  const sessionIsLive = (instanceId: OrchestrationV2Subagent["providerInstanceId"]) => {
    const latest = projection.providerSessions
      .filter((session) => session.providerInstanceId === instanceId)
      .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))[0];
    return latest !== undefined && ["ready", "running", "waiting"].includes(latest.status);
  };
  const candidates = (projection.dulliRuns ?? [])
    .map((agent) =>
      isOrchestrationV2WorkActive(agent.status) && !sessionIsLive(agent.providerInstanceId)
        ? { ...agent, status: "interrupted" as const }
        : agent,
    )
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(b.startedAt ?? b.updatedAt) -
        DateTime.toEpochMillis(a.startedAt ?? a.updatedAt),
    );
  const retained = new Map<string, OrchestrationV2Subagent>();
  const byId = new Map(candidates.map((agent) => [agent.id, agent]));
  const retain = (agent: OrchestrationV2Subagent, seen = new Set<string>()): void => {
    if (retained.has(agent.id) || seen.has(agent.id) || retained.size >= 100) return;
    seen.add(agent.id);
    const parent = byId.get(agent.parentNodeId);
    if (parent) retain(parent, seen);
    if (retained.size < 100) retained.set(agent.id, agent);
  };
  for (const agent of candidates) retain(agent);
  const agents = [...retained.values()];
  const ids = new Set(agents.map((agent) => agent.id));
  const roots = agents.filter((agent) => !ids.has(agent.parentNodeId));
  const groups = new Map<
    string,
    { id: string; prompt: string; agents: OrchestrationV2Subagent[] }
  >();
  for (const agent of roots) {
    const id = agent.runId ?? "background";
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        prompt:
          projection.messages.find(
            (message) => message.runId === agent.runId && message.role === "user",
          )?.text ??
          agent.parentPromptPreview ??
          (agent.runId ? "Earlier prompt" : "Background agents"),
        agents: [],
      };
      groups.set(id, group);
    }
    group.agents.push(agent);
  }
  // Convert each actual Pi record independently: the upstream runtime helper
  // expands workflow snapshots, but those synthetic ids must never replace Pi's
  // durable child ids (history and controls address the real records).
  const liveByNode = new Map<string, OrchestrationV2TurnItem[]>();
  for (const item of projection.dulliTranscript ?? []) {
    if (item.nodeId === null) continue;
    const items = liveByNode.get(item.nodeId) ?? [];
    items.push(item);
    liveByNode.set(item.nodeId, items);
  }
  const runtimeAgents: DulliInspectorAgent[] = agents.map((source) => {
    const runtime = projectedSubagentsToRuntime([source])[0]!;
    const parent = byId.get(source.parentNodeId);
    const member = parent?.workflow?.agents.find(
      (entry) => entry.agentId === source.nativeTaskRef?.nativeId,
    );
    const tools = (liveByNode.get(source.id) ?? [])
      .filter((item) => item.type === "dynamic_tool" && item.toolName !== null)
      .sort((a, b) => a.ordinal - b.ordinal);
    const lastTool =
      tools.findLast((item) => isOrchestrationV2WorkActive(item.status)) ?? tools.at(-1);
    return {
      ...runtime,
      source,
      title: runtime.title.trim() || "Agent",
      prompt: source.prompt,
      kind: source.workflow ? "workflow" : parent?.workflow ? "workflow_agent" : "subagent",
      parentAgentId: ids.has(source.parentNodeId) ? source.parentNodeId : null,
      workflowName: source.workflow?.name ?? parent?.workflow?.name ?? null,
      agentIndex: member?.index ?? null,
      phaseIndex: member?.phaseIndex ?? null,
      phaseTitle:
        member?.phaseTitle ??
        parent?.workflow?.phases.find((phase) => phase.index === member?.phaseIndex)?.title ??
        null,
      attempt: member?.attempt ?? null,
      lastToolName: lastTool?.type === "dynamic_tool" ? lastTool.toolName : null,
    };
  });
  runtimeAgents.sort(
    (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id),
  );
  const runtimeById = new Map(runtimeAgents.map((agent) => [agent.id, agent]));
  const actual = (agent: RuntimeSubagent) => runtimeById.get(agent.id)!;
  const workflows: DulliInspectorWorkflowGroup[] = deriveWorkflowGroups(runtimeAgents).map(
    (group) => ({
      workflow: actual(group.workflow),
      phases: group.phases.map((phase) => ({
        ...phase,
        members: phase.members.map(actual),
        activeCount: phase.members.filter((member) => isActiveSubagentStatus(member.status)).length,
      })),
      unphasedMembers: group.unphasedMembers.map(actual),
    }),
  );
  const directAgents = runtimeAgents.filter(
    (agent) =>
      agent.kind !== "workflow" &&
      !workflows.some((group) => workflowMembers(group).some((member) => member.id === agent.id)),
  );
  const counted = runtimeAgents.filter((agent) => agent.kind !== "workflow");
  const presentation: DulliPanelModel = {
    agents: runtimeAgents,
    directAgents,
    workflows,
    batches: [...groups.values()]
      .sort((a, b) => {
        const first = (group: typeof a) =>
          Math.min(
            ...group.agents.map((agent) =>
              DateTime.toEpochMillis(agent.startedAt ?? agent.updatedAt),
            ),
          );
        return first(a) - first(b) || a.id.localeCompare(b.id);
      })
      .map((group) => ({
        id: group.id,
        prompt: group.prompt,
        directAgents: directAgents.filter(
          (agent) => (agent.source.runId ?? "background") === group.id,
        ),
        workflows: workflows.filter(
          (workflow) => (workflow.workflow.source.runId ?? "background") === group.id,
        ),
      })),
    runningCount: counted.filter(
      (agent) => agent.status === "running" || agent.status === "pending",
    ).length,
    waitingCount: counted.filter((agent) => agent.status === "waiting").length,
    idleCount: counted.filter((agent) => agent.status === "idle").length,
    settledCount: counted.filter((agent) => isTerminalSubagentStatus(agent.status)).length,
    // Coordinator usage is already the sum of its members; never count both.
    totalTokens:
      directAgents.reduce((sum, agent) => sum + (agent.usage?.totalTokens ?? 0), 0) +
      workflows.reduce(
        (sum, group) =>
          sum +
          (group.workflow.usage?.totalTokens ??
            workflowMembers(group).reduce(
              (total, member) => total + (member.usage?.totalTokens ?? 0),
              0,
            )),
        0,
      ),
    hasAgents: runtimeAgents.length > 0,
  };
  return {
    agents,
    presentation,
    revision: (agentId: string) => projection.dulliTranscriptRevisions?.[agentId],
    groups: [...groups.values()],
    children: (agent: OrchestrationV2Subagent) =>
      agents.filter((child) => child.parentNodeId === agent.id),
    transcript: (
      agent: OrchestrationV2Subagent,
      history: ReadonlyArray<OrchestrationV2TurnItem> = [],
    ) => {
      const merged = new Map(
        history.filter((item) => item.nodeId === agent.id).map((item) => [item.id, item]),
      );
      for (const item of projection.dulliTranscript ?? []) {
        if (item.nodeId !== agent.id) continue;
        const previous = merged.get(item.id);
        const order = previous
          ? DateTime.toEpochMillis(item.updatedAt) - DateTime.toEpochMillis(previous.updatedAt)
          : 1;
        if (
          order < 0 ||
          (order === 0 &&
            item.type === "dynamic_tool" &&
            item.outputOmitted &&
            previous?.type === "dynamic_tool" &&
            !previous.outputOmitted)
        )
          continue;
        merged.set(item.id, item);
      }
      return [...merged.values()]
        .filter(
          (item) =>
            ((item.type === "assistant_message" ||
              item.type === "reasoning" ||
              item.type === "user_message") &&
              item.text.length > 0) ||
            item.type === "dynamic_tool",
        )
        .sort((a, b) => a.ordinal - b.ordinal)
        .slice(-1000);
    },
    canControl: (agent: OrchestrationV2Subagent) =>
      agent.id.startsWith("dulli:subagent:") &&
      agent.nativeTaskRef?.strength === "strong" &&
      Boolean(agent.nativeTaskRef.nativeId) &&
      isOrchestrationV2WorkActive(agent.status) &&
      sessionIsLive(agent.providerInstanceId),
  };
}

// REVIEW: The inspector consumes typed conversation entries, not the retired plain-text formatter.
export type DulliTranscriptEntry =
  | {
      readonly id: string;
      readonly kind: "user" | "assistant" | "reasoning";
      readonly text: string;
      readonly live: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly status: OrchestrationV2TurnItem["status"];
      readonly input: string;
      readonly output: string;
      readonly live: boolean;
      readonly source: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
    };

/** Previews are bounded even when input/output are structured rather than strings. */
export function dulliToolPreview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 8000 ? `${text.slice(0, 8000)}\n[preview truncated]` : text;
}

/** Keep later replies even when they quote the task; only the origin is redundant. */
export function dulliTranscriptEntries(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  prompt = "",
  allowLive = true,
): DulliTranscriptEntry[] {
  let removedOrigin = false;
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  const task = normalize(prompt);
  return items.flatMap((item): DulliTranscriptEntry[] => {
    const active = isOrchestrationV2WorkActive(item.status);
    const live = allowLive && active;
    if (item.type === "dynamic_tool")
      return [
        {
          id: item.id,
          kind: "tool",
          name: item.toolName ?? "Tool",
          status: active && !allowLive ? "interrupted" : item.status,
          input: dulliToolPreview(item.input),
          output: dulliToolPreview(item.output),
          live,
          source: item,
        },
      ];
    if (
      item.type !== "user_message" &&
      item.type !== "assistant_message" &&
      item.type !== "reasoning"
    )
      return [];
    if (item.type === "user_message" && !removedOrigin && task) {
      const text = normalize(item.text);
      const prefix = task.replace(/(?:…|\.{3})$/u, "").trim();
      if (text === task || text.includes(task) || (prefix.length >= 64 && text.includes(prefix))) {
        removedOrigin = true;
        return [];
      }
    }
    return [
      {
        id: item.id,
        kind:
          item.type === "user_message"
            ? "user"
            : item.type === "assistant_message"
              ? "assistant"
              : "reasoning",
        text: item.text,
        live,
      },
    ];
  });
}
