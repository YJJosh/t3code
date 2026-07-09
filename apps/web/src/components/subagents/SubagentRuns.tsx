import {
  isSubagentRunActive,
  selectSubagentRuns,
  subagentRunNeedsInput,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useSubagentRuntime } from "../../state/useSubagentRuntime";
import { SubagentRunControls } from "./SubagentRunControls";
import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
  subagentRunTitle,
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

const TONE_DOT_CLASS = {
  info: "bg-info",
  warning: "bg-warning",
  success: "bg-success",
  error: "bg-destructive",
} as const;

function runAccessibleStatus(run: SubagentRunEntry): string {
  const status = subagentStatusLabel(run.view.state);
  if (subagentRunNeedsInput(run.view.state)) {
    return `${status} — needs your input`;
  }
  return status;
}

function SubagentStatusBadge({ run }: { run: SubagentRunEntry }) {
  const tone = subagentStatusTone(run.view.state);
  return (
    <Badge variant={TONE_BADGE_VARIANT[tone]} size="sm">
      {subagentStatusLabel(run.view.state)}
    </Badge>
  );
}

interface SubagentRunRowProps {
  run: SubagentRunEntry;
  selected: boolean;
  onSelect: (runId: string) => void;
}

function SubagentRunRow({ run, selected, onSelect }: SubagentRunRowProps) {
  const tone = subagentStatusTone(run.view.state);
  const title = subagentRunTitle(run.view.task, run.view.runId);
  const active = isSubagentRunActive(run.view.state);
  return (
    <button
      type="button"
      onClick={() => onSelect(run.view.runId)}
      aria-expanded={selected}
      aria-haspopup="dialog"
      aria-label={`Subagent run: ${title}. Status: ${runAccessibleStatus(run)}`}
      className={cn(
        "group flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
        selected && "border-border bg-accent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          TONE_DOT_CLASS[tone],
          active && "animate-pulse",
        )}
      />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {subagentStatusLabel(run.view.state)}
      </span>
    </button>
  );
}

function SubagentActivityTranscript({ run }: { run: SubagentRunEntry }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const latestActivitySequence = run.activity.at(-1)?.sequence ?? 0;

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport === undefined || viewport === null) {
      return;
    }

    const updateStickiness = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= 24;
    };
    viewport.addEventListener("scroll", updateStickiness, { passive: true });
    return () => viewport.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport !== undefined && viewport !== null) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [latestActivitySequence]);

  if (run.activity.length === 0) {
    return <p className="text-xs text-muted-foreground">No child activity yet.</p>;
  }

  return (
    <ScrollArea ref={rootRef} className="min-h-0 flex-1 rounded-md border border-border/60">
      <ul className="flex flex-col gap-0.5 p-1.5">
        {run.activity.map((entry) => (
          <li
            key={entry.sequence}
            className="flex items-start gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground"
          >
            <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/70">
              {entry.type}
            </span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground/90">
              {summarizeSubagentActivity(entry)}
            </span>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

interface SubagentRunDetailProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  run: SubagentRunEntry;
}

function SubagentRunDetail({ environmentId, threadId, run }: SubagentRunDetailProps) {
  const view = run.view;
  const title = subagentRunTitle(view.task, view.runId);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <SubagentStatusBadge run={run} />
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt className="font-medium">Model</dt>
            <dd className="truncate">{view.model}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="font-medium">Turns</dt>
            <dd>{view.turns}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="font-medium">Active</dt>
            <dd>{formatSubagentActiveMs(view.activeMs)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="font-medium">Usage</dt>
            <dd className="truncate">
              {formatSubagentTokens(view.usageSoFar)} · {formatSubagentCost(view.usageSoFar)}
            </dd>
          </div>
          <div className="col-span-2 flex gap-1">
            <dt className="font-medium">Directory</dt>
            <dd className="truncate">{view.directory}</dd>
          </div>
          {view.skills.length > 0 && (
            <div className="col-span-2 flex gap-1">
              <dt className="font-medium">Skills</dt>
              <dd className="truncate">{view.skills.join(", ")}</dd>
            </div>
          )}
        </dl>
      </div>

      {view.progressNote !== undefined && view.progressNote.trim().length > 0 && (
        <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
          {view.progressNote}
        </p>
      )}

      {view.managerRequest !== undefined && (
        <div className="rounded-md border border-warning/40 bg-warning/8 px-2.5 py-2 text-xs">
          <p className="font-medium text-foreground">Waiting on input</p>
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
            {view.managerRequest.message}
          </p>
        </div>
      )}

      {view.openQuestions.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium text-foreground">Open questions</p>
          <ul className="list-disc pl-4 text-muted-foreground">
            {view.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      {view.result !== undefined && (
        <div className="flex flex-col gap-1 rounded-md border border-border/70 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">Result</span>
            <Badge
              variant={subagentStatusTone(view.result.status) === "success" ? "success" : "outline"}
              size="sm"
            >
              {view.result.status}
            </Badge>
          </div>
          {view.result.result?.summary !== undefined && (
            <p className="whitespace-pre-wrap text-muted-foreground">
              {view.result.result.summary}
            </p>
          )}
          {view.result.result !== undefined && view.result.result.files_changed.length > 0 && (
            <p className="text-muted-foreground">
              {view.result.result.files_changed.length} file(s) changed
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium text-foreground">Activity</p>
        <SubagentActivityTranscript run={run} />
      </div>

      <SubagentRunControls environmentId={environmentId} threadId={threadId} run={run} />
    </div>
  );
}

export interface SubagentRunsProps {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  /** Whether the active provider/session can support Pi subagents. */
  enabled: boolean;
}

/**
 * Compact live rows for a thread's Pi subagent runs, rendered directly below
 * the composer, plus an overlay drawer (desktop) / near-full-screen sheet
 * (compact) with per-run metadata, transcript, usage, status, and controls.
 *
 * Renders nothing when there are no runs so an idle/empty stream is invisible.
 */
export function SubagentRuns({ environmentId, threadId, enabled }: SubagentRunsProps) {
  const { state } = useSubagentRuntime({ environmentId, threadId, enabled });
  const runs = useMemo(() => selectSubagentRuns(state), [state]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

  const selectedRun = selectedRunId === null ? null : (state.runs.get(selectedRunId) ?? null);
  const close = useCallback(() => setSelectedRunId(null), []);

  if (!enabled || environmentId === null || threadId === null || runs.length === 0) {
    return null;
  }

  return (
    <>
      <div
        className="pointer-events-auto flex flex-wrap items-center gap-1.5 pb-1"
        role="list"
        aria-label="Subagent runs"
      >
        {runs.map((run) => (
          <div role="listitem" key={run.view.runId}>
            <SubagentRunRow
              run={run}
              selected={run.view.runId === selectedRunId}
              onSelect={setSelectedRunId}
            />
          </div>
        ))}
      </div>

      <Sheet
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
      >
        <SheetPopup
          side="right"
          showCloseButton
          className={cn(
            "gap-0 p-4",
            useSheet ? "w-full max-w-none" : "w-[min(42vw,28rem)] min-w-80 max-w-[28rem]",
          )}
        >
          <SheetTitle className="sr-only">Subagent run details</SheetTitle>
          {selectedRun !== null && (
            <SubagentRunDetail
              key={selectedRun.view.runId}
              environmentId={environmentId}
              threadId={threadId}
              run={selectedRun}
            />
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
