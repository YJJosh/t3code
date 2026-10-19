import type {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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
  return {
    agents,
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
            (item.type === "dynamic_tool" && (item.input !== "" || item.output !== "")),
        )
        .sort((a, b) => a.ordinal - b.ordinal)
        .slice(-1000);
    },
    canControl: (agent: OrchestrationV2Subagent) =>
      agent.id.startsWith("dulli:subagent:") &&
      agent.nativeTaskRef?.strength === "strong" &&
      isOrchestrationV2WorkActive(agent.status) &&
      sessionIsLive(agent.providerInstanceId),
  };
}

export function dulliTranscriptText(item: OrchestrationV2TurnItem): string {
  if (
    item.type === "assistant_message" ||
    item.type === "reasoning" ||
    item.type === "user_message"
  )
    return item.text;
  if (item.type !== "dynamic_tool") return "";
  const output = typeof item.output === "string" ? item.output : "";
  const input = typeof item.input === "string" ? item.input : "";
  return [input, output].filter(Boolean).join("\n");
}
