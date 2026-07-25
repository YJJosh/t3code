import {
  selectSubagentTranscriptActivity,
  type SubagentActivityEntry,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowLeftIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { SubagentRunControls } from "./SubagentRunControls";
import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
  subagentActivityLabel,
  subagentRunDisplayTitle,
  subagentRunStatusLabel,
  subagentStatusLabel,
  subagentStatusTone,
  summarizeSubagentActivity,
} from "./subagentPresentation";

const TONE_BADGE_VARIANT = {
  info: "info",
  warning: "warning",
  success: "success",
  error: "error",
} as const;

function SubagentStatusBadge({ run }: { run: SubagentRunEntry }) {
  const tone = subagentStatusTone(run.view.state);
  return (
    <Badge variant={TONE_BADGE_VARIANT[tone]} size="sm">
      {subagentRunStatusLabel(run)}
    </Badge>
  );
}

function activityTime(entry: SubagentActivityEntry): string {
  const date = new Date(entry.timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function SubagentActivityTranscript({ run }: { run: SubagentRunEntry }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const activity = useMemo(() => selectSubagentTranscriptActivity(run), [run]);
  const latestActivitySequence = activity.reduce(
    (latest, entry) => Math.max(latest, entry.sequence),
    0,
  );

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport === undefined || viewport === null) return;

    const updateStickiness = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= 24;
    };
    viewport.addEventListener("scroll", updateStickiness, { passive: true });
    return () => viewport.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport !== undefined && viewport !== null) viewport.scrollTop = viewport.scrollHeight;
  }, [latestActivitySequence]);

  if (activity.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border/70 text-xs text-muted-foreground">
        Waiting for agent activity…
      </div>
    );
  }

  return (
    <ScrollArea
      ref={rootRef}
      className="h-[min(24rem,42vh)] min-h-52 rounded-lg border border-border/65 bg-muted/15"
    >
      <ol className="flex flex-col p-2">
        {activity.map((entry) => (
          <li
            key={entry.sequence}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-muted/35"
          >
            <span className="truncate font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              {subagentActivityLabel(entry)}
            </span>
            <span
              className={cn(
                "min-w-0 break-words whitespace-pre-wrap text-foreground/90",
                entry.kind === "child_tool" && "font-mono text-[10px]",
              )}
            >
              {summarizeSubagentActivity(entry)}
            </span>
            <time className="text-[9px] text-muted-foreground/70" dateTime={entry.timestamp}>
              {activityTime(entry)}
            </time>
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function DetailMetadata({ run }: { run: SubagentRunEntry }) {
  const view = run.view;
  const capabilities = [
    ...view.skills,
    ...(view.mcpServers ?? []).map((server) => `MCP: ${server}`),
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div className="rounded-md bg-muted/35 px-2.5 py-2">
        <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Model</dt>
        <dd className="mt-0.5 truncate font-medium text-foreground" title={view.model}>
          {view.model}
        </dd>
      </div>
      <div className="rounded-md bg-muted/35 px-2.5 py-2">
        <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Turns</dt>
        <dd className="mt-0.5 font-medium text-foreground">{view.turns}</dd>
      </div>
      <div className="rounded-md bg-muted/35 px-2.5 py-2">
        <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Active</dt>
        <dd className="mt-0.5 font-medium text-foreground">
          {formatSubagentActiveMs(view.activeMs)}
        </dd>
      </div>
      <div className="rounded-md bg-muted/35 px-2.5 py-2">
        <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Usage</dt>
        <dd className="mt-0.5 truncate font-medium text-foreground">
          {formatSubagentTokens(view.usageSoFar)}
        </dd>
        <dd className="text-[9px] text-muted-foreground">{formatSubagentCost(view.usageSoFar)}</dd>
      </div>
      <div className="col-span-2 rounded-md bg-muted/35 px-2.5 py-2 sm:col-span-4">
        <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Directory</dt>
        <dd
          className="mt-0.5 truncate font-mono text-[10px] text-foreground"
          title={view.directory}
        >
          {view.directory}
        </dd>
      </div>
      {capabilities.length > 0 && (
        <div className="col-span-2 rounded-md bg-muted/35 px-2.5 py-2 sm:col-span-4">
          <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Capabilities</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {capabilities.map((capability) => (
              <Badge key={capability} variant="outline" size="sm">
                {capability}
              </Badge>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

function SubagentResult({ run }: { run: SubagentRunEntry }) {
  const result = run.view.result;
  if (result === undefined) return null;
  return (
    <section className="rounded-lg border border-border/70 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground">Result</h3>
        <Badge
          variant={subagentStatusTone(result.status) === "success" ? "success" : "outline"}
          size="sm"
        >
          {subagentStatusLabel(result.status)}
        </Badge>
      </div>
      {result.result?.summary !== undefined && (
        <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground">{result.result.summary}</p>
      )}
      {result.reason !== undefined && result.result?.summary === undefined && (
        <p className="mt-1.5 whitespace-pre-wrap text-destructive-foreground">{result.reason}</p>
      )}
      {result.result !== undefined && result.result.files_changed.length > 0 && (
        <div className="mt-2 text-muted-foreground">
          <p className="font-medium text-foreground">
            {result.result.files_changed.length} file
            {result.result.files_changed.length === 1 ? "" : "s"} changed
          </p>
          <ul className="mt-1 list-disc pl-4">
            {result.result.files_changed.map((path) => (
              <li key={path} className="break-all font-mono text-[10px]">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export interface SubagentRunDetailProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  run: SubagentRunEntry;
  onBack?: (() => void) | undefined;
}

export function SubagentRunDetail({
  environmentId,
  threadId,
  run,
  onBack,
}: SubagentRunDetailProps) {
  const view = run.view;
  const workflow = view.workflow;
  const title = subagentRunDisplayTitle(run);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-4 pt-3 sm:p-5">
        <header className="flex items-start gap-2 pr-8">
          {onBack !== undefined && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
              autoFocus
              aria-label="Back to agent list"
              data-subagent-detail-back
              className="-ml-1 shrink-0"
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            {workflow !== undefined && (
              <p className="mb-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                <WorkflowIcon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{workflow.name ?? workflow.runId}</span>
                {workflow.phase !== undefined && workflow.phase.trim().length > 0 && (
                  <>
                    <span aria-hidden="true">/</span>
                    <span className="truncate">{workflow.phase}</span>
                  </>
                )}
              </p>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
              <SubagentStatusBadge run={run} />
            </div>
            <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
              {view.runId}
            </p>
          </div>
        </header>

        <section className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
          <h3 className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Task
          </h3>
          <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-foreground/90">
            {view.task}
          </p>
        </section>

        <DetailMetadata run={run} />

        {view.progressNote !== undefined && view.progressNote.trim().length > 0 && (
          <section className="rounded-lg border border-info/25 bg-info/5 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-foreground">Progress</h3>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{view.progressNote}</p>
          </section>
        )}

        {workflow !== undefined && view.state === "needs_input" ? (
          <section className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-foreground">Workflow agent stopping</h3>
            <p className="mt-1 text-muted-foreground">
              Workflow agents are unattended and cannot pause for a reply. Pi is stopping this
              agent; the workflow will decide how to proceed.
            </p>
          </section>
        ) : (
          view.managerRequest !== undefined && (
            <section className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-xs">
              <h3 className="font-semibold text-foreground">Waiting on input</h3>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {view.managerRequest.message}
              </p>
            </section>
          )
        )}

        {view.openQuestions.length > 0 &&
          !(workflow !== undefined && view.state === "needs_input") && (
            <section className="text-xs">
              <h3 className="font-semibold text-foreground">Open questions</h3>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {view.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </section>
          )}

        <SubagentResult run={run} />

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">Activity</h3>
            <span className="text-[9px] text-muted-foreground">Live transcript</span>
          </div>
          <SubagentActivityTranscript run={run} />
        </section>

        <SubagentRunControls environmentId={environmentId} threadId={threadId} run={run} />
      </div>
    </ScrollArea>
  );
}
