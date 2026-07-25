import type {
  SubagentRunEntry,
  SubagentRunGroups,
  SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagents";
import { BotIcon, WorkflowIcon } from "lucide-react";
import { useMemo } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import {
  formatSubagentActiveMs,
  subagentRosterOverviewLabel,
  subagentRunAccessibleStatus,
  subagentRunDisplayTitle,
  subagentRunStatusLabel,
  subagentStatusTone,
  subagentWorkflowTitle,
  summarizeSubagentRoster,
} from "./subagentPresentation";

const TONE_DOT_CLASS = {
  info: "bg-info",
  warning: "bg-warning",
  success: "bg-success",
  error: "bg-destructive",
} as const;

interface SubagentRosterRowProps {
  run: SubagentRunEntry;
  selected: boolean;
  autoFocus: boolean;
  onSelect: (runId: string) => void;
}

function SubagentRosterRow({ run, selected, autoFocus, onSelect }: SubagentRosterRowProps) {
  const title = subagentRunDisplayTitle(run);
  const tone = subagentStatusTone(run.view.state);
  return (
    <button
      type="button"
      onClick={() => onSelect(run.view.runId)}
      autoFocus={autoFocus}
      data-subagent-run-id={run.view.runId}
      aria-current={selected ? "true" : undefined}
      aria-label={`${title}. ${subagentRunAccessibleStatus(run.view.state, run.view.workflow !== undefined)}`}
      className={cn(
        "group flex w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/70",
        selected && "bg-accent text-accent-foreground",
        run.view.state === "needs_input" && !selected && "bg-warning/8",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[tone])}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{run.view.model}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{formatSubagentActiveMs(run.view.activeMs)}</span>
        </span>
      </span>
      <span className="mt-0.5 shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
        {subagentRunStatusLabel(run)}
      </span>
    </button>
  );
}

interface WorkflowPhaseGroup {
  readonly phase: string | null;
  readonly runs: ReadonlyArray<SubagentRunEntry>;
}

function groupWorkflowPhases(workflow: SubagentWorkflowGroup): ReadonlyArray<WorkflowPhaseGroup> {
  const groups = new Map<string | null, SubagentRunEntry[]>();
  for (const run of workflow.runs) {
    const phase = run.view.workflow?.phase?.trim() || null;
    const phaseRuns = groups.get(phase) ?? [];
    phaseRuns.push(run);
    groups.set(phase, phaseRuns);
  }
  return Array.from(groups, ([phase, runs]) => ({ phase, runs }));
}

function WorkflowRosterGroup({
  workflow,
  selectedRunId,
  autoFocusRunId,
  onSelect,
}: {
  workflow: SubagentWorkflowGroup;
  selectedRunId: string | null;
  autoFocusRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const phases = useMemo(() => groupWorkflowPhases(workflow), [workflow]);
  const stats = useMemo(() => summarizeSubagentRoster(workflow.runs), [workflow.runs]);
  return (
    <section
      className="overflow-hidden rounded-lg border border-border/65 bg-card/35"
      aria-labelledby={`workflow-${workflow.workflowId}`}
    >
      <div className="flex items-start gap-2 border-b border-border/55 px-3 py-2.5">
        <WorkflowIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3
            id={`workflow-${workflow.workflowId}`}
            className="truncate text-xs font-semibold text-foreground"
          >
            {subagentWorkflowTitle(workflow)}
          </h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {workflow.runs.length} agent{workflow.runs.length === 1 ? "" : "s"} ·{" "}
            {subagentRosterOverviewLabel(stats)}
          </p>
        </div>
      </div>
      <div className="p-1">
        {phases.map((phase, index) => (
          <div key={phase.phase ?? `unphased-${index}`}>
            {phase.phase !== null && (
              <p className="px-2.5 pt-2 pb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
                {phase.phase}
              </p>
            )}
            <div role="list" aria-label={phase.phase ?? "Workflow agents"}>
              {phase.runs.map((run) => (
                <div role="listitem" key={run.view.runId}>
                  <SubagentRosterRow
                    run={run}
                    selected={selectedRunId === run.view.runId}
                    autoFocus={autoFocusRunId === run.view.runId}
                    onSelect={onSelect}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface SubagentRunRosterProps {
  groups: SubagentRunGroups;
  selectedRunId: string | null;
  autoFocusRunId?: string | null;
  onSelect: (runId: string) => void;
}

export function SubagentRunRoster({
  groups,
  selectedRunId,
  autoFocusRunId = null,
  onSelect,
}: SubagentRunRosterProps) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        {groups.workflows.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <WorkflowIcon className="size-3" aria-hidden />
              Workflows
            </div>
            {groups.workflows.map((workflow) => (
              <WorkflowRosterGroup
                key={workflow.workflowId}
                workflow={workflow}
                selectedRunId={selectedRunId}
                autoFocusRunId={autoFocusRunId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}

        {groups.standalone.length > 0 && (
          <section aria-labelledby="standalone-agents-heading">
            <div
              id="standalone-agents-heading"
              className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              <BotIcon className="size-3" aria-hidden />
              {groups.workflows.length > 0 ? "Standalone" : "Agents"}
            </div>
            <div
              role="list"
              aria-label="Standalone agents"
              className="rounded-lg border border-border/65 p-1"
            >
              {groups.standalone.map((run) => (
                <div role="listitem" key={run.view.runId}>
                  <SubagentRosterRow
                    run={run}
                    selected={selectedRunId === run.view.runId}
                    autoFocus={autoFocusRunId === run.view.runId}
                    onSelect={onSelect}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
