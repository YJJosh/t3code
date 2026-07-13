import {
  isSubagentRunActive,
  selectSubagentRuns,
  selectSubagentTranscriptActivity,
  subagentRunNeedsInput,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useResizableWidth, useViewportClampedMaxWidth } from "../../hooks/useResizableWidth";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useSubagentRuntime } from "../../state/useSubagentRuntime";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { SubagentRunControls } from "./SubagentRunControls";
import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
  groupSubagentRunsForRoster,
  subagentActivityLabel,
  subagentRosterSummaryLabel,
  subagentRunAccessibleStatus,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
  summarizeSubagentActivity,
} from "./subagentPresentation";

const SUBAGENT_DETAIL_WIDTH_STORAGE_KEY = "t3code:subagent-detail-width";
const SUBAGENT_DETAIL_DEFAULT_WIDTH = 448;
const SUBAGENT_DETAIL_MIN_WIDTH = 320;
const SUBAGENT_DETAIL_MAX_WIDTH = 1_120;
const SUBAGENT_DETAIL_MAX_VIEWPORT_FRACTION = 0.7;

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
  /** Finished runs render muted, since they're tucked behind the summary toggle. */
  quiet: boolean;
  onSelect: (runId: string) => void;
}

function SubagentRunRow({ run, selected, quiet, onSelect }: SubagentRunRowProps) {
  const tone = subagentStatusTone(run.view.state);
  const title = subagentRunTitle(run.view.task, run.view.runId);
  const active = isSubagentRunActive(run.view.state);
  const needsInput = subagentRunNeedsInput(run.view.state);
  return (
    <button
      type="button"
      onClick={() => onSelect(run.view.runId)}
      aria-expanded={selected}
      aria-haspopup="dialog"
      aria-label={`Subagent run: ${title}. Status: ${subagentRunAccessibleStatus(run.view.state)}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
        selected && "bg-accent",
        needsInput && !selected && "bg-warning/8",
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
      <span
        className={cn(
          "hidden shrink-0 max-w-24 truncate font-mono text-[10px] text-muted-foreground/80 sm:inline",
        )}
      >
        {run.view.model}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          quiet ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {title}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {formatSubagentActiveMs(run.view.activeMs)}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {subagentStatusLabel(run.view.state)}
      </span>
    </button>
  );
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

  if (activity.length === 0) {
    return <p className="text-xs text-muted-foreground">No child activity yet.</p>;
  }

  return (
    <ScrollArea ref={rootRef} className="min-h-0 flex-1 rounded-md border border-border/60">
      <ul className="flex flex-col gap-0.5 p-1.5">
        {activity.map((entry) => (
          <li
            key={entry.sequence}
            className="flex items-start gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground"
          >
            <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/70">
              {subagentActivityLabel(entry)}
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
            <div className="text-muted-foreground">
              <p>{view.result.result.files_changed.length} file(s) changed</p>
              <ul className="mt-0.5 list-disc pl-4">
                {view.result.result.files_changed.map((path) => (
                  <li key={path} className="break-all font-mono text-[10px]">
                    {path}
                  </li>
                ))}
              </ul>
            </div>
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
 * Compact roster panel for a thread's Pi subagent runs, rendered directly
 * above the composer: active/waiting/failed runs stay always visible, and
 * finished runs collapse behind a summary toggle so they don't permanently
 * eat composer space. Selecting a row opens an overlay drawer (desktop) /
 * near-full-screen sheet (compact) with per-run metadata, transcript, usage,
 * status, and controls.
 *
 * Renders nothing when there are no runs so an idle/empty stream is invisible.
 */
export function SubagentRuns({ environmentId, threadId, enabled }: SubagentRunsProps) {
  const { state } = useSubagentRuntime({ environmentId, threadId, enabled });
  const runs = useMemo(() => selectSubagentRuns(state), [state]);
  const { attention, quiet } = useMemo(() => groupSubagentRunsForRoster(runs), [runs]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [quietExpanded, setQuietExpanded] = useState(false);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const maxDetailWidth = useViewportClampedMaxWidth({
    maxWidth: SUBAGENT_DETAIL_MAX_WIDTH,
    maxViewportFraction: SUBAGENT_DETAIL_MAX_VIEWPORT_FRACTION,
  });
  const { width: detailWidth, handlers: detailResizeHandlers } = useResizableWidth({
    storageKey: SUBAGENT_DETAIL_WIDTH_STORAGE_KEY,
    defaultWidth: SUBAGENT_DETAIL_DEFAULT_WIDTH,
    minWidth: SUBAGENT_DETAIL_MIN_WIDTH,
    maxWidth: maxDetailWidth,
    edge: "left",
  });

  useEffect(() => {
    setSelectedRunId(null);
    setQuietExpanded(false);
  }, [environmentId, threadId]);

  const selectedRun = selectedRunId === null ? null : (state.runs.get(selectedRunId) ?? null);
  const close = useCallback(() => setSelectedRunId(null), []);

  if (!enabled || environmentId === null || threadId === null || runs.length === 0) {
    return null;
  }

  return (
    <>
      <div className="pointer-events-auto mx-auto mb-1.5 max-h-48 w-full max-w-3xl overflow-y-auto rounded-lg border border-border/70 bg-card/85 p-1 shadow-sm backdrop-blur-sm sm:max-h-56">
        {attention.length > 0 && (
          <div role="list" aria-label="Subagent runs needing attention">
            {attention.map((run) => (
              <div role="listitem" key={run.view.runId}>
                <SubagentRunRow
                  run={run}
                  selected={run.view.runId === selectedRunId}
                  quiet={false}
                  onSelect={setSelectedRunId}
                />
              </div>
            ))}
          </div>
        )}

        {quiet.length > 0 && (
          <Collapsible open={quietExpanded} onOpenChange={setQuietExpanded}>
            <CollapsibleTrigger
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/60 data-panel-open:[&_svg]:rotate-90"
              aria-label={`${subagentRosterSummaryLabel(quiet.length)}, ${quietExpanded ? "expanded" : "collapsed"}`}
            >
              <ChevronRightIcon
                className="size-3 shrink-0 transition-transform"
                aria-hidden="true"
              />
              {subagentRosterSummaryLabel(quiet.length)}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div role="list" aria-label="Finished subagent runs">
                {quiet.map((run) => (
                  <div role="listitem" key={run.view.runId}>
                    <SubagentRunRow
                      run={run}
                      selected={run.view.runId === selectedRunId}
                      quiet
                      onSelect={setSelectedRunId}
                    />
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        )}
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
          className={cn("gap-0 p-4", useSheet ? "w-full max-w-none" : "min-w-80 max-w-none")}
          style={useSheet ? undefined : { width: `${detailWidth}px` }}
        >
          {!useSheet && <RightPanelResizeHandle handlers={detailResizeHandlers} />}
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
