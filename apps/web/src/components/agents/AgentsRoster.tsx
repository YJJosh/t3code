import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Braces, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";

import {
  AGENT_STATUS_VISUALS,
  AgentElapsed,
  agentActivityText,
  agentRosterBatches,
  agentElapsedBetween,
  AgentStatusDot,
  workflowIsLive,
  workflowMembers,
} from "./agentsPresentation";

function AgentRosterRow({
  agent,
  selected,
  autoFocus,
  onSelect,
  nested = false,
}: {
  agent: RuntimeSubagent;
  selected: boolean;
  autoFocus: boolean;
  onSelect: (agent: RuntimeSubagent) => void;
  nested?: boolean;
}) {
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
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
        "grid w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-2 py-1 text-left hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        nested ? "h-[3.5rem]" : "h-[3.875rem]",
        selected && "bg-accent text-accent-foreground",
        agent.status === "waiting" && !selected && "bg-warning/8",
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <AgentStatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
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
        {metadata.join(" · ")}
      </span>
    </button>
  );
}

function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-2 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close workflow script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

function PhaseSection({
  phase,
  selectedAgentId,
  autoFocusAgentId,
  onSelectAgent,
  defaultOpen = false,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  selectedAgentId: string | null;
  autoFocusAgentId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
  defaultOpen?: boolean;
}) {
  const shouldRestoreFocus = phase.members.some((member) => member.id === autoFocusAgentId);
  const [open, setOpen] = useState(defaultOpen || phase.state === "running" || shouldRestoreFocus);
  const previousState = useRef(phase.state);

  useEffect(() => {
    if ((previousState.current !== "running" && phase.state === "running") || shouldRestoreFocus) {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state, shouldRestoreFocus]);

  return (
    <section aria-label={phase.title} className="border-s border-border/60 ps-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex min-h-7 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.68rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3" />
        ) : (
          <ChevronRight aria-hidden className="size-3" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
      </button>
      {open ? (
        <div
          role="list"
          aria-label={`${phase.title} agents`}
          className="ms-2 border-s border-border/45 ps-1.5"
        >
          {phase.members.map((member) => (
            <div role="listitem" key={member.id}>
              <AgentRosterRow
                agent={member}
                selected={selectedAgentId === member.id}
                autoFocus={autoFocusAgentId === member.id}
                onSelect={onSelectAgent}
                nested
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WorkflowSection({
  group,
  environmentId,
  threadId,
  selectedAgentId,
  autoFocusAgentId,
  onSelectAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  selectedAgentId: string | null;
  autoFocusAgentId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const live = workflowIsLive(group);
  const displayStatus: RuntimeSubagent["status"] =
    failed > 0 ? "failed" : live ? "running" : "completed";
  const settled = members.filter((member) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(member.status),
  ).length;
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? agentElapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  const shouldRestoreFocus = members.some((member) => member.id === autoFocusAgentId);
  const previousLive = useRef(live);

  useEffect(() => {
    if ((!previousLive.current && live) || shouldRestoreFocus) {
      setOpen(true);
    }
    previousLive.current = live;
  }, [live, shouldRestoreFocus]);

  if (!open) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
          aria-expanded={false}
        >
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <AgentStatusDot status={displayStatus} />
          <span className="truncate text-sm">
            {group.workflow.workflowName ?? group.workflow.title}
          </span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
            {failed > 0 ? (
              <span className="text-destructive-foreground">{failed} failed</span>
            ) : null}
            <span>{members.length} agents</span>
            <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
            {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          </span>
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border/55 bg-card/30 p-1">
      <div className="flex items-center gap-2 px-2 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => setOpen(false)}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
        <AgentStatusDot status={displayStatus} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto shrink-0 font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
      </div>
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.length > 0 ? (
        <div className="ms-3 mt-1 space-y-1" aria-label="Workflow phases">
          {group.phases.map((phase) => (
            <PhaseSection
              key={phase.index}
              phase={phase}
              selectedAgentId={selectedAgentId}
              autoFocusAgentId={autoFocusAgentId}
              onSelectAgent={onSelectAgent}
              defaultOpen={!live}
            />
          ))}
        </div>
      ) : null}
      {group.unphasedMembers.length > 0 ? (
        <div
          role="list"
          aria-label="Workflow agents"
          className="ms-3 border-s border-border/60 ps-2"
        >
          {group.unphasedMembers.map((member) => (
            <div role="listitem" key={member.id}>
              <AgentRosterRow
                agent={member}
                selected={selectedAgentId === member.id}
                autoFocus={autoFocusAgentId === member.id}
                onSelect={onSelectAgent}
                nested
              />
            </div>
          ))}
        </div>
      ) : null}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <div role="list" aria-label="Workflow coordinator">
          <div role="listitem">
            <AgentRosterRow
              agent={group.workflow}
              selected={selectedAgentId === group.workflow.id}
              autoFocus={autoFocusAgentId === group.workflow.id}
              onSelect={onSelectAgent}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function AgentsRoster({
  model,
  environmentId,
  threadId,
  selectedAgentId,
  autoFocusAgentId,
  onSelectAgent,
}: {
  model: AgentPanelModel;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  selectedAgentId: string | null;
  autoFocusAgentId: string | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
}) {
  const batches = agentRosterBatches(model);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-2.5">
        {batches.map((batch, batchIndex) => (
          <section
            key={batch.id}
            aria-label={`Prompt ${batchIndex + 1} agents`}
            className={cn("space-y-2", batchIndex > 0 && "border-t border-border/60 pt-3")}
          >
            {batches.length > 1 ? (
              <h2 className="px-1 text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Prompt {batchIndex + 1}
                <span className="ms-1 font-normal normal-case tracking-normal text-muted-foreground/65">
                  · {batch.directAgents.length + batch.workflows.length} run
                  {batch.directAgents.length + batch.workflows.length === 1 ? "" : "s"}
                </span>
              </h2>
            ) : null}
            {batch.directAgents.length > 0 ? (
              <div role="list" aria-label={`Prompt ${batchIndex + 1} direct agents`}>
                {batch.directAgents.map((agent) => (
                  <div role="listitem" key={agent.id}>
                    <AgentRosterRow
                      agent={agent}
                      selected={selectedAgentId === agent.id}
                      autoFocus={autoFocusAgentId === agent.id}
                      onSelect={onSelectAgent}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            {batch.workflows.map((group) => (
              <WorkflowSection
                key={group.workflow.id}
                group={group}
                environmentId={environmentId}
                threadId={threadId}
                selectedAgentId={selectedAgentId}
                autoFocusAgentId={autoFocusAgentId}
                onSelectAgent={onSelectAgent}
              />
            ))}
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
