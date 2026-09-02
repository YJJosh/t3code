import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { GitBranch } from "lucide-react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import {
  AGENT_STATUS_VISUALS,
  AgentElapsed,
  agentActivityText,
  agentElapsedBetween,
  agentRosterBatches,
  AgentStatusDot,
  workflowIsLive,
  workflowMembers,
} from "./agentsPresentation";

function AgentRosterRow({
  agent,
  selected,
  autoFocus,
  onSelect,
}: {
  agent: RuntimeSubagent;
  selected: boolean;
  autoFocus: boolean;
  onSelect: (agent: RuntimeSubagent) => void;
}) {
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={() => onSelect(agent)}
      autoFocus={autoFocus}
      aria-current={selected ? "true" : undefined}
      aria-label={`${agent.title}. ${visuals.label}`}
      data-agent-run-id={agent.id}
      className={cn(
        "grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-2 py-1 text-left hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-accent text-accent-foreground",
        agent.status === "waiting" && !selected && "bg-warning/8",
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <AgentStatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
        {agent.title}
      </span>
      <span className="col-start-3 row-start-1 min-w-10 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <AgentElapsed agent={agent} />
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? visuals.label}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ") || "Subagent"}
      </span>
    </button>
  );
}

function WorkflowRosterRow({
  group,
  selected,
  autoFocus,
  onSelect,
}: {
  group: AgentPanelWorkflowGroup;
  selected: boolean;
  autoFocus: boolean;
  onSelect: (group: AgentPanelWorkflowGroup) => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const live = workflowIsLive(group);
  const status: RuntimeSubagent["status"] =
    failed > 0 || group.workflow.status === "failed"
      ? "failed"
      : live
        ? "running"
        : group.workflow.status;
  const active = members.filter((member) =>
    ["pending", "running", "waiting"].includes(member.status),
  );
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? agentElapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(group)}
      autoFocus={autoFocus}
      aria-current={selected ? "true" : undefined}
      aria-label={`${group.workflow.workflowName ?? group.workflow.title}. Workflow`}
      data-workflow-run-id={group.workflow.id}
      className={cn(
        "grid h-[3.875rem] w-full grid-cols-[1rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-2 py-1 text-left hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <GitBranch aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
        {group.workflow.workflowName ?? group.workflow.title}
      </span>
      <span className="col-start-3 row-start-1 flex items-center gap-1 font-mono text-[.7rem] text-muted-foreground/80">
        <AgentStatusDot status={status} />
        {live ? <AgentElapsed agent={group.workflow} /> : elapsed}
      </span>
      <span className="col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground">
        {status === "failed"
          ? `${Math.max(1, failed)} failed`
          : active.length > 0
            ? `${active.length} agent${active.length === 1 ? "" : "s"} working`
            : `${members.length} agent${members.length === 1 ? "" : "s"} settled`}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] text-muted-foreground/70">
        Workflow · {formatSubagentTokenCount(totalTokens)} tok
      </span>
    </button>
  );
}

export function AgentsRoster({
  model,
  selectedAgentId,
  selectedWorkflowId,
  autoFocusTargetId,
  onSelectAgent,
  onSelectWorkflow,
}: {
  model: AgentPanelModel;
  selectedAgentId: string | null;
  selectedWorkflowId: string | null;
  autoFocusTargetId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
  onSelectWorkflow: (group: AgentPanelWorkflowGroup) => void;
}) {
  const batches = agentRosterBatches(model);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-2.5">
        {batches.map((batch, batchIndex) => (
          <section
            key={batch.id}
            aria-label={`Prompt ${batchIndex + 1} agents`}
            className={cn("space-y-1", batchIndex > 0 && "border-t border-border/60 pt-3")}
          >
            {batches.length > 1 ? (
              <h2 className="px-1 pb-1 text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Prompt {batchIndex + 1}
                <span className="ms-1 font-normal normal-case tracking-normal text-muted-foreground/65">
                  · {batch.directAgents.length + batch.workflows.length} run
                  {batch.directAgents.length + batch.workflows.length === 1 ? "" : "s"}
                </span>
              </h2>
            ) : null}
            <div role="list" aria-label={`Prompt ${batchIndex + 1} runs`}>
              {batch.directAgents.map((agent) => (
                <div role="listitem" key={agent.id}>
                  <AgentRosterRow
                    agent={agent}
                    selected={selectedAgentId === agent.id}
                    autoFocus={autoFocusTargetId === agent.id}
                    onSelect={onSelectAgent}
                  />
                </div>
              ))}
              {batch.workflows.map((group) => (
                <div role="listitem" key={group.workflow.id}>
                  <WorkflowRosterRow
                    group={group}
                    selected={selectedWorkflowId === group.workflow.id}
                    autoFocus={autoFocusTargetId === group.workflow.id}
                    onSelect={onSelectWorkflow}
                  />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
