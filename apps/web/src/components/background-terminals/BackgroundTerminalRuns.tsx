import {
  isBackgroundTerminalActive,
  isBackgroundTerminalOutputTruncated,
  selectBackgroundTerminals,
  type BackgroundTerminalEntry,
  type BackgroundTerminalOutputBuffer,
} from "@t3tools/client-runtime/state/background-terminals";
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
import { useBackgroundTerminalRuntime } from "../../state/useBackgroundTerminalRuntime";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { BackgroundTerminalControls } from "./BackgroundTerminalControls";
import {
  backgroundTerminalAccessibleStatus,
  backgroundTerminalElapsedLabel,
  backgroundTerminalExitSummary,
  backgroundTerminalRosterSummaryLabel,
  backgroundTerminalStatusLabel,
  backgroundTerminalStatusTone,
  backgroundTerminalTitle,
  backgroundTerminalTruncatedBytes,
  formatBytes,
  groupBackgroundTerminalsForRoster,
  sanitizeTerminalOutputText,
} from "./backgroundTerminalPresentation";

const DETAIL_WIDTH_STORAGE_KEY = "t3code:background-terminal-detail-width";
const DETAIL_DEFAULT_WIDTH = 448;
const DETAIL_MIN_WIDTH = 320;
const DETAIL_MAX_WIDTH = 1_120;
const DETAIL_MAX_VIEWPORT_FRACTION = 0.7;
/** Refresh interval for the live elapsed-time readout while a terminal is running. */
const ELAPSED_TICK_MS = 1_000;

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

type OutputStreamKind = "stdout" | "stderr";

function BackgroundTerminalStatusBadge({ terminal }: { terminal: BackgroundTerminalEntry }) {
  const tone = backgroundTerminalStatusTone(terminal.view.status);
  return (
    <Badge variant={TONE_BADGE_VARIANT[tone]} size="sm">
      {backgroundTerminalStatusLabel(terminal.view.status)}
    </Badge>
  );
}

interface BackgroundTerminalRowProps {
  terminal: BackgroundTerminalEntry;
  selected: boolean;
  /** Settled terminals render muted, since they're tucked behind the summary toggle. */
  quiet: boolean;
  onSelect: (terminalId: string) => void;
}

function BackgroundTerminalRow({
  terminal,
  selected,
  quiet,
  onSelect,
}: BackgroundTerminalRowProps) {
  const tone = backgroundTerminalStatusTone(terminal.view.status);
  const title = backgroundTerminalTitle(terminal.view);
  const active = isBackgroundTerminalActive(terminal.view.status);
  return (
    <button
      type="button"
      onClick={() => onSelect(terminal.view.id)}
      aria-expanded={selected}
      aria-haspopup="dialog"
      aria-label={`Background terminal: ${title}. Status: ${backgroundTerminalAccessibleStatus(terminal.view.status)}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
        selected && "bg-accent",
        terminal.view.status === "failed" && !selected && "bg-destructive/8",
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
          "min-w-0 flex-1 truncate",
          quiet ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {title}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {backgroundTerminalElapsedLabel(terminal.view)}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {backgroundTerminalStatusLabel(terminal.view.status)}
      </span>
    </button>
  );
}

interface BackgroundTerminalOutputPaneProps {
  buffer: BackgroundTerminalOutputBuffer;
}

/** Sanitized plain preformatted live tail: sticky to the bottom while the reader hasn't scrolled up. */
function BackgroundTerminalOutputPane({ buffer }: BackgroundTerminalOutputPaneProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const text = useMemo(() => sanitizeTerminalOutputText(buffer.text), [buffer.text]);
  const truncated = isBackgroundTerminalOutputTruncated(buffer);
  const truncatedBytesLabel = useMemo(
    () => formatBytes(backgroundTerminalTruncatedBytes(buffer)),
    [buffer],
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
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {truncated && (
        <p className="rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
          Earlier output truncated ({truncatedBytesLabel} dropped)
        </p>
      )}
      <ScrollArea ref={rootRef} className="min-h-0 flex-1 rounded-md border border-border/60">
        {text.length === 0 ? (
          <p className="p-1.5 text-xs text-muted-foreground">No output yet.</p>
        ) : (
          <pre className="min-w-0 whitespace-pre-wrap break-words p-1.5 font-mono text-[11px] text-foreground/90">
            {text}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}

interface BackgroundTerminalDetailProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  terminal: BackgroundTerminalEntry;
}

function BackgroundTerminalDetail({
  environmentId,
  threadId,
  terminal,
}: BackgroundTerminalDetailProps) {
  const view = terminal.view;
  const title = backgroundTerminalTitle(view);
  const [selectedStream, setSelectedStream] = useState<OutputStreamKind>(
    view.status === "failed" ? "stderr" : "stdout",
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isBackgroundTerminalActive(view.status);

  useEffect(() => {
    if (!running) {
      return;
    }
    const id = window.setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const exitSummary = backgroundTerminalExitSummary(view);
  const activeBuffer = selectedStream === "stdout" ? terminal.stdout : terminal.stderr;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <BackgroundTerminalStatusBadge terminal={terminal} />
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <div className="col-span-2 flex gap-1">
            <dt className="font-medium">Command</dt>
            <dd className="min-w-0 truncate break-all font-mono">{view.command}</dd>
          </div>
          <div className="col-span-2 flex gap-1">
            <dt className="font-medium">Directory</dt>
            <dd className="min-w-0 truncate">{view.cwd}</dd>
          </div>
          {view.pid !== undefined && (
            <div className="flex gap-1">
              <dt className="font-medium">PID</dt>
              <dd>{view.pid}</dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt className="font-medium">Elapsed</dt>
            <dd>{backgroundTerminalElapsedLabel(view, nowMs)}</dd>
          </div>
        </dl>
      </div>

      {exitSummary !== null && (
        <div
          className={cn(
            "rounded-md border px-2.5 py-2 text-xs",
            view.status === "failed"
              ? "border-destructive/40 bg-destructive/8"
              : "border-border/70 bg-muted/40",
          )}
        >
          <p className="font-medium text-foreground">Exit details</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {exitSummary}
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div role="tablist" aria-label="Terminal output stream" className="flex items-center gap-1">
          {(["stdout", "stderr"] as const).map((stream) => (
            <button
              key={stream}
              type="button"
              role="tab"
              id={`background-terminal-tab-${stream}`}
              aria-selected={selectedStream === stream}
              aria-controls={`background-terminal-tabpanel-${stream}`}
              onClick={() => setSelectedStream(stream)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors",
                selectedStream === stream
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {stream}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`background-terminal-tabpanel-${selectedStream}`}
          aria-labelledby={`background-terminal-tab-${selectedStream}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          <BackgroundTerminalOutputPane buffer={activeBuffer} />
        </div>
      </div>

      <BackgroundTerminalControls
        environmentId={environmentId}
        threadId={threadId}
        terminal={terminal}
      />
    </div>
  );
}

export interface BackgroundTerminalRunsProps {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  /** Whether the active provider/session can support Pi background terminals. */
  enabled: boolean;
}

/**
 * Compact roster panel for a thread's Pi background terminals, rendered
 * directly above the composer: running/failed terminals stay always visible,
 * and settled (done/killed) terminals collapse behind a summary toggle so
 * they don't permanently eat composer space. Selecting a row opens an
 * overlay drawer (desktop) / near-full-screen sheet (compact) with metadata,
 * stdout/stderr tail, and a kill-only control.
 *
 * Renders nothing when there are no terminals so an idle/empty stream is
 * invisible. Deliberately exposes no start/restart/stdin controls —
 * background terminals are spawned by Pi, not by the client.
 */
export function BackgroundTerminalRuns({
  environmentId,
  threadId,
  enabled,
}: BackgroundTerminalRunsProps) {
  const { state } = useBackgroundTerminalRuntime({ environmentId, threadId, enabled });
  const terminals = useMemo(() => selectBackgroundTerminals(state), [state]);
  const { attention, quiet } = useMemo(
    () => groupBackgroundTerminalsForRoster(terminals),
    [terminals],
  );
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [quietExpanded, setQuietExpanded] = useState(false);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const maxDetailWidth = useViewportClampedMaxWidth({
    maxWidth: DETAIL_MAX_WIDTH,
    maxViewportFraction: DETAIL_MAX_VIEWPORT_FRACTION,
  });
  const { width: detailWidth, handlers: detailResizeHandlers } = useResizableWidth({
    storageKey: DETAIL_WIDTH_STORAGE_KEY,
    defaultWidth: DETAIL_DEFAULT_WIDTH,
    minWidth: DETAIL_MIN_WIDTH,
    maxWidth: maxDetailWidth,
    edge: "left",
  });

  useEffect(() => {
    setSelectedTerminalId(null);
    setQuietExpanded(false);
  }, [environmentId, threadId]);

  const selectedTerminal =
    selectedTerminalId === null ? null : (state.terminals.get(selectedTerminalId) ?? null);
  const close = useCallback(() => setSelectedTerminalId(null), []);

  if (!enabled || environmentId === null || threadId === null || terminals.length === 0) {
    return null;
  }

  return (
    <>
      <div className="pointer-events-auto mx-auto mb-1.5 max-h-48 w-full max-w-3xl overflow-y-auto rounded-lg border border-border/70 bg-card/85 p-1 shadow-sm backdrop-blur-sm sm:max-h-56">
        {attention.length > 0 && (
          <div role="list" aria-label="Background terminals needing attention">
            {attention.map((terminal) => (
              <div role="listitem" key={terminal.view.id}>
                <BackgroundTerminalRow
                  terminal={terminal}
                  selected={terminal.view.id === selectedTerminalId}
                  quiet={false}
                  onSelect={setSelectedTerminalId}
                />
              </div>
            ))}
          </div>
        )}

        {quiet.length > 0 && (
          <Collapsible open={quietExpanded} onOpenChange={setQuietExpanded}>
            <CollapsibleTrigger
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/60 data-panel-open:[&_svg]:rotate-90"
              aria-label={`${backgroundTerminalRosterSummaryLabel(quiet.length)}, ${quietExpanded ? "expanded" : "collapsed"}`}
            >
              <ChevronRightIcon
                className="size-3 shrink-0 transition-transform"
                aria-hidden="true"
              />
              {backgroundTerminalRosterSummaryLabel(quiet.length)}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div role="list" aria-label="Settled background terminals">
                {quiet.map((terminal) => (
                  <div role="listitem" key={terminal.view.id}>
                    <BackgroundTerminalRow
                      terminal={terminal}
                      selected={terminal.view.id === selectedTerminalId}
                      quiet
                      onSelect={setSelectedTerminalId}
                    />
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        )}
      </div>

      <Sheet
        open={selectedTerminal !== null}
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
          <SheetTitle className="sr-only">Background terminal details</SheetTitle>
          {selectedTerminal !== null && (
            <BackgroundTerminalDetail
              key={selectedTerminal.view.id}
              environmentId={environmentId}
              threadId={threadId}
              terminal={selectedTerminal}
            />
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
