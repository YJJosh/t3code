import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { ArrowLeft, Check, ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import {
  AGENT_STATUS_VISUALS,
  AgentElapsed,
  agentActivityText,
  AgentStatusDot,
  workflowIsLive,
  workflowMembers,
} from "./agentsPresentation";

function phaseStatusText(phase: AgentPanelWorkflowGroup["phases"][number]): string {
  const failed = phase.members.filter((member) => member.status === "failed").length;
  if (failed > 0) return `${failed} failed`;
  if (phase.activeCount > 0) {
    return `${phase.activeCount} agent${phase.activeCount === 1 ? "" : "s"} running`;
  }
  if (phase.settledCount > 0) {
    return `${phase.settledCount} agent${phase.settledCount === 1 ? "" : "s"} settled`;
  }
  return "pending";
}

function WorkflowAgentNode({
  agent,
  selected,
  onSelect,
}: {
  agent: RuntimeSubagent;
  selected: boolean;
  onSelect: (agent: RuntimeSubagent) => void;
}) {
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  return (
    <button
      type="button"
      onClick={() => onSelect(agent)}
      aria-current={selected ? "true" : undefined}
      aria-label={`${agent.title}. ${visuals.label}`}
      className={cn(
        "relative grid min-h-[3.5rem] w-full grid-cols-[0.5rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1rem] items-center gap-x-2 rounded-md border border-transparent px-2 py-1.5 text-left before:absolute before:-left-7 before:top-1/2 before:w-7 before:border-t before:border-border/65 hover:border-border/55 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "border-border/70 bg-accent text-accent-foreground",
      )}
    >
      <AgentStatusDot status={agent.status} />
      <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
      <span className="font-mono text-[.7rem] text-muted-foreground">
        <AgentElapsed agent={agent} />
      </span>
      <span className="col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground">
        {activity ?? visuals.label}
      </span>
    </button>
  );
}

function WorkflowPhaseBranch({
  phase,
  first,
  selectedAgentId,
  onSelectAgent,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  first: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
}) {
  const containsSelection = phase.members.some((member) => member.id === selectedAgentId);
  const failed = phase.members.some((member) => member.status === "failed");
  const [open, setOpen] = useState(phase.state === "running" || first || containsSelection);

  useEffect(() => {
    if (phase.state === "running" || containsSelection) setOpen(true);
  }, [containsSelection, phase.state]);

  return (
    <section aria-label={phase.title} className="relative pb-5 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="relative flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left before:absolute before:-left-8 before:top-1/2 before:w-8 before:border-t before:border-border/70 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        {failed ? (
          <AgentStatusDot status="failed" />
        ) : phase.state === "done" ? (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/12 text-success-foreground">
            <Check aria-hidden className="size-3" />
          </span>
        ) : (
          <AgentStatusDot status={phase.state === "running" ? "running" : "pending"} />
        )}
        <span className="min-w-0 truncate text-base font-semibold text-foreground">
          {phase.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{phaseStatusText(phase)}</span>
      </button>
      {open ? (
        <div
          role="list"
          aria-label={`${phase.title} agents`}
          className="relative ml-8 space-y-1 border-l border-border/55 py-1 pl-7"
        >
          {phase.members.map((member) => (
            <div role="listitem" key={member.id}>
              <WorkflowAgentNode
                agent={member}
                selected={selectedAgentId === member.id}
                onSelect={onSelectAgent}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function WorkflowDetail({
  group,
  selectedAgentId,
  onSelectAgent,
  onBack,
}: {
  group: AgentPanelWorkflowGroup;
  selectedAgentId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
  onBack?: (() => void) | undefined;
}) {
  const members = workflowMembers(group);
  const live = workflowIsLive(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const settled = members.filter((member) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(member.status),
  ).length;
  const tokens = members.reduce((sum, member) => sum + (member.usage?.totalTokens ?? 0), 0);
  const status: RuntimeSubagent["status"] =
    failed > 0 || group.workflow.status === "failed"
      ? "failed"
      : live
        ? "running"
        : group.workflow.status;
  const visuals = AGENT_STATUS_VISUALS[status];

  return (
    <ScrollArea className="min-h-0 flex-1" data-workflow-detail={group.workflow.id}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex min-w-0 items-start gap-2">
          {onBack ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
              autoFocus
              aria-label="Back to agent list"
              className="-ml-1 shrink-0"
            >
              <ArrowLeft aria-hidden />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-[.7rem] font-medium uppercase tracking-wider text-muted-foreground">
              Workflow
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <GitBranch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <h2 className="min-w-0 truncate text-lg font-semibold text-foreground">
                {group.workflow.workflowName ?? group.workflow.title}
              </h2>
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-border/65 px-2 py-0.5 text-[.65rem] text-muted-foreground">
                <AgentStatusDot status={status} />
                {visuals.label}
              </span>
            </div>
            <p className="mt-1 font-mono text-[.7rem] text-muted-foreground">
              {settled}/{members.length} settled · Σ {formatSubagentTokenCount(tokens)} tok
            </p>
          </div>
        </header>

        <div
          aria-label={`${group.workflow.workflowName ?? group.workflow.title} workflow map`}
          className="relative pl-10"
        >
          <div
            aria-hidden
            className="absolute bottom-5 left-[1.15rem] top-8 border-l-2 border-border/65"
          />
          <div className="relative mb-5 flex min-h-14 items-center rounded-lg border border-border/65 bg-card/35 px-3 before:absolute before:-left-[1.8rem] before:top-1/2 before:w-[1.8rem] before:border-t-2 before:border-border/65">
            <GitBranch aria-hidden className="mr-2 size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Workflow started</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {members.length} agent{members.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="relative ml-8">
            {group.phases.map((phase, index) => (
              <WorkflowPhaseBranch
                key={`${group.workflow.id}:${phase.index}`}
                phase={phase}
                first={index === 0}
                selectedAgentId={selectedAgentId}
                onSelectAgent={onSelectAgent}
              />
            ))}
            {group.unphasedMembers.length > 0 ? (
              <section aria-label="Workflow agents" className="relative pb-2">
                <div className="relative mb-1 flex h-10 items-center px-2 before:absolute before:-left-8 before:top-1/2 before:w-8 before:border-t before:border-border/70">
                  <ChevronDown aria-hidden className="mr-2 size-4 text-muted-foreground" />
                  <span className="text-base font-semibold">Agents</span>
                </div>
                <div role="list" className="ml-8 space-y-1 border-l border-border/55 py-1 pl-7">
                  {group.unphasedMembers.map((member) => (
                    <div role="listitem" key={member.id}>
                      <WorkflowAgentNode
                        agent={member}
                        selected={selectedAgentId === member.id}
                        onSelect={onSelectAgent}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
