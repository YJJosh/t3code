import {
  isSubagentRunActive,
  selectSubagentRunGroups,
  selectSubagentRuns,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useResizableWidth, useViewportClampedMaxWidth } from "../../hooks/useResizableWidth";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useSubagentRuntime } from "../../state/useSubagentRuntime";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { SubagentRunDetail } from "./SubagentRunDetail";
import { SubagentRunRoster } from "./SubagentRunRoster";
import {
  subagentRosterOverviewLabel,
  summarizeSubagentRoster,
  type SubagentRosterStats,
} from "./subagentPresentation";

const SUBAGENT_INSPECTOR_WIDTH_STORAGE_KEY = "t3code:subagent-inspector-width";
const SUBAGENT_INSPECTOR_DEFAULT_WIDTH = 880;
const SUBAGENT_INSPECTOR_MIN_WIDTH = 640;
const SUBAGENT_INSPECTOR_MAX_WIDTH = 1_200;
const SUBAGENT_INSPECTOR_MAX_VIEWPORT_FRACTION = 0.9;

function preferredRun(runs: ReadonlyArray<SubagentRunEntry>): SubagentRunEntry | null {
  return (
    runs.find((run) => run.view.state === "needs_input") ??
    runs.find((run) => isSubagentRunActive(run.view.state)) ??
    runs.find((run) => run.view.state === "failed") ??
    runs.at(-1) ??
    null
  );
}

type StatusSummaryTone = "info" | "warning" | "success" | "error" | "stopped";

const STATUS_SUMMARY_VARIANT = {
  info: "info",
  warning: "warning",
  success: "success",
  error: "error",
  stopped: "secondary",
} as const;

const STATUS_SUMMARY_DOT_CLASS = {
  info: "bg-info",
  warning: "bg-warning",
  success: "bg-success",
  error: "bg-destructive",
  stopped: "bg-muted-foreground",
} as const;

function StatusSummaryBadge({
  count,
  label,
  tone,
  pulse = false,
}: {
  count: number;
  label: string;
  tone: StatusSummaryTone;
  pulse?: boolean;
}) {
  if (count === 0) return null;
  return (
    <Badge
      size="sm"
      variant={STATUS_SUMMARY_VARIANT[tone]}
      className="h-4 min-w-0 gap-1 rounded-full px-1.5 text-[9px]"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          STATUS_SUMMARY_DOT_CLASS[tone],
          pulse && "animate-pulse",
        )}
        aria-hidden
      />
      {count} {label}
    </Badge>
  );
}

function SubagentStatusSummary({ stats }: { stats: SubagentRosterStats }) {
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1" aria-hidden>
      <StatusSummaryBadge count={stats.needsInput} label="waiting" tone="warning" />
      <StatusSummaryBadge count={stats.workflowStopping} label="stopping" tone="warning" />
      <StatusSummaryBadge count={stats.spawning} label="spawning" tone="info" pulse />
      <StatusSummaryBadge count={stats.running} label="running" tone="info" pulse />
      <StatusSummaryBadge count={stats.done} label="done" tone="success" />
      <StatusSummaryBadge count={stats.failed} label="failed" tone="error" />
      <StatusSummaryBadge count={stats.stopped} label="stopped" tone="stopped" />
    </span>
  );
}

export interface SubagentRunsProps {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  /** Whether the active provider/session can support Pi subagents. */
  enabled: boolean;
}

/**
 * Compact thread-level entry point into the Pi agent inspector. Workflow-owned
 * children are grouped by workflow metadata from the bridge, while controls
 * remain explicitly per-agent because v1 does not expose authoritative
 * workflow lifecycle or whole-workflow controls.
 */
export function SubagentRuns({ environmentId, threadId, enabled }: SubagentRunsProps) {
  const { state } = useSubagentRuntime({ environmentId, threadId, enabled });
  const runs = useMemo(() => selectSubagentRuns(state), [state]);
  const groups = useMemo(() => selectSubagentRunGroups(state), [state]);
  const stats = useMemo(() => summarizeSubagentRoster(runs), [runs]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [compactReturnFocusRunId, setCompactReturnFocusRunId] = useState<string | null>(null);
  const compactLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const maxInspectorWidth = useViewportClampedMaxWidth({
    maxWidth: SUBAGENT_INSPECTOR_MAX_WIDTH,
    maxViewportFraction: SUBAGENT_INSPECTOR_MAX_VIEWPORT_FRACTION,
  });
  const { width: inspectorWidth, handlers: inspectorResizeHandlers } = useResizableWidth({
    storageKey: SUBAGENT_INSPECTOR_WIDTH_STORAGE_KEY,
    defaultWidth: SUBAGENT_INSPECTOR_DEFAULT_WIDTH,
    minWidth: SUBAGENT_INSPECTOR_MIN_WIDTH,
    maxWidth: maxInspectorWidth,
    edge: "left",
  });

  const preferredRunId = useMemo(() => preferredRun(runs)?.view.runId ?? null, [runs]);
  const selectedRun = selectedRunId === null ? null : (state.runs.get(selectedRunId) ?? null);

  useEffect(() => {
    setInspectorOpen(false);
    setSelectedRunId(null);
    setCompactReturnFocusRunId(null);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (inspectorOpen && !compactLayout && selectedRun === null) {
      setSelectedRunId(preferredRunId);
    }
  }, [compactLayout, inspectorOpen, preferredRunId, selectedRun]);

  const selectRun = useCallback((runId: string) => {
    setCompactReturnFocusRunId(null);
    setSelectedRunId(runId);
  }, []);

  const showRoster = useCallback(() => {
    setCompactReturnFocusRunId(selectedRunId);
    setSelectedRunId(null);
  }, [selectedRunId]);

  const openInspector = useCallback(() => {
    if (!compactLayout && selectedRunId === null) setSelectedRunId(preferredRunId);
    setInspectorOpen(true);
  }, [compactLayout, preferredRunId, selectedRunId]);

  if (!enabled || environmentId === null || threadId === null || runs.length === 0) {
    return null;
  }

  const overview = subagentRosterOverviewLabel(stats);
  const workflowCount = groups.workflows.length;

  return (
    <>
      <button
        type="button"
        onClick={openInspector}
        aria-label={`Open agent inspector. ${stats.total} agents. ${overview}`}
        className={cn(
          "pointer-events-auto mx-auto mb-1.5 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border/70 bg-card/85 px-3 py-2 text-left shadow-sm backdrop-blur-sm transition-colors hover:bg-accent/70",
          (stats.needsInput > 0 || stats.workflowStopping > 0) && "border-warning/40 bg-warning/6",
        )}
      >
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <BotIcon className="size-3.5" aria-hidden />
          {(stats.active > 0 || stats.needsInput > 0 || stats.workflowStopping > 0) && (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-card",
                stats.needsInput > 0 || stats.workflowStopping > 0
                  ? "bg-warning"
                  : "bg-info animate-pulse",
              )}
              aria-hidden
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground">
              {stats.total} agent{stats.total === 1 ? "" : "s"}
            </span>
            {workflowCount > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                <WorkflowIcon className="size-2.5" aria-hidden />
                {workflowCount} workflow{workflowCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
          <SubagentStatusSummary stats={stats} />
        </span>
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">Inspect</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      <Sheet
        open={inspectorOpen}
        onOpenChange={(open) => {
          if (!open) setCompactReturnFocusRunId(null);
          setInspectorOpen(open);
        }}
      >
        <SheetPopup
          side="right"
          showCloseButton
          className={cn("gap-0 p-0", compactLayout ? "w-full max-w-none" : "max-w-none")}
          style={compactLayout ? undefined : { width: `${inspectorWidth}px` }}
        >
          {!compactLayout && <RightPanelResizeHandle handlers={inspectorResizeHandlers} />}
          <header className="shrink-0 border-b border-border/65 px-4 py-3 pr-12">
            <SheetTitle className="text-base">Agent inspector</SheetTitle>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {stats.total} agent{stats.total === 1 ? "" : "s"}
              {workflowCount > 0
                ? ` in ${workflowCount} workflow${workflowCount === 1 ? "" : "s"}`
                : ""}
              {` · ${overview}`}
            </p>
          </header>

          {compactLayout ? (
            selectedRun === null ? (
              <SubagentRunRoster
                groups={groups}
                selectedRunId={selectedRunId}
                autoFocusRunId={compactReturnFocusRunId}
                onSelect={selectRun}
              />
            ) : (
              <SubagentRunDetail
                key={selectedRun.view.runId}
                environmentId={environmentId}
                threadId={threadId}
                run={selectedRun}
                onBack={showRoster}
              />
            )
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-80 min-w-64 shrink-0 flex-col border-r border-border/65">
                <SubagentRunRoster
                  groups={groups}
                  selectedRunId={selectedRunId}
                  onSelect={selectRun}
                />
              </aside>
              <main className="flex min-w-0 flex-1 flex-col">
                {selectedRun === null ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                    <BotIcon className="size-8 opacity-50" aria-hidden />
                    <p className="text-sm font-medium text-foreground">Select an agent</p>
                    <p className="max-w-64 text-xs">
                      Inspect its live transcript, usage, result, and available controls.
                    </p>
                  </div>
                ) : (
                  <SubagentRunDetail
                    key={selectedRun.view.runId}
                    environmentId={environmentId}
                    threadId={threadId}
                    run={selectedRun}
                  />
                )}
              </main>
            </div>
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
