import {
  isBackgroundTerminalActive,
  selectBackgroundTerminalControlResult,
  selectBackgroundTerminals,
} from "@t3tools/client-runtime/state/background-terminals";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronLeft, Plus, Terminal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";

import { useBackgroundTerminalRuntime } from "../../state/useBackgroundTerminalRuntime";
import { useSplitInspectorLayout } from "../AgentsPanel";
import { BackgroundTerminalDetail, BackgroundTerminalRow } from "./BackgroundTerminalRuns";
import {
  backgroundTerminalRosterSummaryLabel,
  groupBackgroundTerminalsForRoster,
} from "./backgroundTerminalPresentation";
import {
  BACKGROUND_TERMINAL_START_UNAVAILABLE,
  useStartBackgroundTerminal,
  type StartBackgroundTerminalOptions,
} from "./useStartBackgroundTerminal";

export interface BackgroundTerminalsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Whether the active provider/session can support Pi background terminals. */
  enabled: boolean;
  /** Terminal preselected by whoever opened the surface (strip row, slash command). */
  selectedTerminalId: string | null;
}

function StartTerminalForm({
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  error: string | null;
  onSubmit: (options: StartBackgroundTerminalOptions) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [command, setCommand] = useState("");
  const [title, setTitle] = useState("");
  const [interactive, setInteractive] = useState(true);
  const [keepOpen, setKeepOpen] = useState(false);
  const canSubmit = !pending && command.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-2 border-b border-border/65 px-3 py-2.5"
      aria-label="Start a shared terminal"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          command,
          ...(title.trim() ? { title } : {}),
          interactive,
          keepOpen: interactive && keepOpen,
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-command`}>Command</Label>
        <Input
          id={`${id}-command`}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="bash -i"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-title`}>Title (optional)</Label>
        <Input
          id={`${id}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Shared shell"
          autoComplete="off"
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-interactive`}
            checked={interactive}
            onCheckedChange={(checked) => setInteractive(checked === true)}
          />
          <Label htmlFor={`${id}-interactive`}>Interactive (you and Pi can type)</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-keep-open`}
            checked={interactive && keepOpen}
            disabled={!interactive}
            onCheckedChange={(checked) => setKeepOpen(checked === true)}
          />
          <Label htmlFor={`${id}-keep-open`}>Keep a shell open after it exits</Label>
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {pending ? <Spinner /> : null}
          Start
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Right-panel surface for a thread's shared (Pi background) terminals: a
 * roster of running and settled terminals, the selected terminal's detail
 * (live PTY screen or output tail plus controls), and a form that starts a
 * new terminal inside the live Pi session so both the user and Pi can use it.
 * Mirrors the Agents inspector: split roster/detail when wide, stacked when
 * narrow.
 */
export function BackgroundTerminalsPanel({
  environmentId,
  threadId,
  enabled,
  selectedTerminalId,
}: BackgroundTerminalsPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const splitLayout = useSplitInspectorLayout(rootRef);
  const { state } = useBackgroundTerminalRuntime({ environmentId, threadId, enabled });
  const terminals = useMemo(() => selectBackgroundTerminals(state), [state]);
  const { attention, quiet } = useMemo(
    () => groupBackgroundTerminalsForRoster(terminals),
    [terminals],
  );
  const runningCount = useMemo(
    () => terminals.filter((entry) => isBackgroundTerminalActive(entry.view.status)).length,
    [terminals],
  );
  const [selectedId, setSelectedId] = useState<string | null>(selectedTerminalId);
  const [formOpen, setFormOpen] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pendingStartRequestId, setPendingStartRequestId] = useState<string | null>(null);
  const starter = useStartBackgroundTerminal({
    environmentId,
    threadId,
    managerId: state.managerId,
  });

  // Follow whoever opened the surface with a terminal (strip row, /terminal).
  useEffect(() => {
    if (selectedTerminalId !== null) setSelectedId(selectedTerminalId);
  }, [selectedTerminalId]);

  // A terminal started here is selected as soon as Pi acknowledges it with an id.
  useEffect(() => {
    if (pendingStartRequestId === null) return;
    const result = selectBackgroundTerminalControlResult(state, pendingStartRequestId);
    if (result === null) return;
    setPendingStartRequestId(null);
    if (result.success && result.terminalId !== undefined) {
      setSelectedId(result.terminalId);
      setFormOpen(false);
    } else if (!result.success) {
      setStartError(result.error ?? "Pi could not start the terminal.");
    }
  }, [pendingStartRequestId, state]);

  const selected = selectedId === null ? null : (state.terminals.get(selectedId) ?? null);

  const startTerminal = async (options: StartBackgroundTerminalOptions) => {
    setStartPending(true);
    setStartError(null);
    try {
      const result = await starter.start(options);
      if ("error" in result) {
        setStartError(result.error);
      } else {
        setPendingStartRequestId(result.requestId);
      }
    } finally {
      setStartPending(false);
    }
  };

  if (!enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Terminal aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">Shared terminals need the Pi provider</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          Switch this thread to Pi to start terminals that you and the agent can both use.
        </p>
      </div>
    );
  }

  const rows = (entries: typeof terminals, quietRows: boolean) =>
    entries.map((terminal) => (
      <div role="listitem" key={terminal.view.id}>
        <BackgroundTerminalRow
          terminal={terminal}
          selected={terminal.view.id === selectedId}
          quiet={quietRows}
          onSelect={setSelectedId}
        />
      </div>
    ));

  const roster = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {terminals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Terminal aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">No shared terminals yet</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            {starter.available
              ? "Start one here, type /terminal <command> in the composer, or ask Pi to run bg_start with interactive on."
              : BACKGROUND_TERMINAL_START_UNAVAILABLE}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-2">
          {attention.length > 0 && (
            <div role="list" aria-label="Running terminals">
              {rows(attention, false)}
            </div>
          )}
          {quiet.length > 0 && (
            <>
              <p className="px-2 pt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                {backgroundTerminalRosterSummaryLabel(quiet.length)}
              </p>
              <div role="list" aria-label="Settled terminals">
                {rows(quiet, true)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  const detail =
    selected !== null && state.managerId !== null ? (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {!splitLayout && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => setSelectedId(null)}
          >
            <ChevronLeft className="size-3.5" />
            All terminals
          </Button>
        )}
        <BackgroundTerminalDetail
          key={`${state.managerId}:${selected.view.id}`}
          environmentId={environmentId}
          threadId={threadId}
          managerId={state.managerId}
          terminal={selected}
        />
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <Terminal aria-hidden className="size-8 opacity-50" />
        <p className="text-sm font-medium text-foreground">Select a terminal</p>
        <p className="max-w-72 text-xs">
          Interactive terminals open as a live screen you can take control of. Others show their
          output.
        </p>
      </div>
    );

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col"
      data-shared-terminals-layout={splitLayout ? "split" : "compact"}
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/65 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-semibold text-foreground">Shared terminals</h1>
            <span className="text-2xs text-muted-foreground">
              {terminals.length} terminal{terminals.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {runningCount > 0 ? `${runningCount} running` : "No running terminals"}
            {quiet.length > 0 ? ` · ${quiet.length} settled` : ""}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={formOpen}
          disabled={!starter.available}
          title={starter.available ? undefined : BACKGROUND_TERMINAL_START_UNAVAILABLE}
          onClick={() => setFormOpen((open) => !open)}
        >
          <Plus className="size-3.5" />
          Start terminal
        </Button>
      </header>

      {formOpen && starter.available ? (
        <StartTerminalForm
          pending={startPending || pendingStartRequestId !== null}
          error={startError}
          onSubmit={(options) => void startTerminal(options)}
          onCancel={() => {
            setFormOpen(false);
            setStartError(null);
          }}
        />
      ) : null}

      {splitLayout ? (
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Shared terminals"
            className="flex w-72 min-w-64 shrink-0 flex-col border-r border-border/65"
          >
            {roster}
          </aside>
          <section aria-label="Terminal detail" className="flex min-w-0 flex-1 flex-col">
            {detail}
          </section>
        </div>
      ) : selected !== null ? (
        detail
      ) : (
        roster
      )}

      <footer className="flex shrink-0 items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span>{runningCount > 0 ? `● ${runningCount} running` : `${quiet.length} settled`}</span>
        <span>{state.managerId === null ? "Pi not running" : "Pi session live"}</span>
      </footer>
    </div>
  );
}
