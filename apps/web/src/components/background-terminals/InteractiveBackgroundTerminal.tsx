import type { BackgroundTerminalEntry } from "@t3tools/client-runtime/state/background-terminals";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  DulliBackgroundTerminalControlInput,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { randomUUID } from "../../lib/utils";
import { Button } from "~/components/ui/button";
import { backgroundTerminalEnvironment } from "../../state/backgroundTerminals";
import { useAtomCommand } from "../../state/use-atom-command";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";
import { createTerminalInputBatcher, screenToVt } from "./interactiveTerminal";

type Control =
  | { action: "watch" | "unwatch" | "attach" | "release" }
  | { action: "send"; data: string }
  | { action: "resize"; cols: number; rows: number };

export function InteractiveBackgroundTerminal({
  environmentId,
  threadId,
  managerId,
  terminal,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  managerId: string;
  terminal: BackgroundTerminalEntry;
}) {
  const permitted = useAtomValue(
    backgroundTerminalEnvironment.control.permissionAtom(environmentId),
  );
  const [clientId] = useState(() => randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [watching, setWatching] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const surface = useRef<GhosttyTerminalSurface | null>(null);
  const input = useRef<ReturnType<typeof createTerminalInputBatcher> | null>(null);
  const latest = useRef(terminal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The asynchronously created Ghostty surface needs the latest committed screen on initialization.
  useLayoutEffect(() => {
    latest.current = terminal;
  }, [terminal]);
  const controlling = terminal.view.controller === clientId && terminal.view.status === "running";
  const controllingRef = useRef(controlling);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retained Ghostty input handlers must follow committed ownership without recreating the terminal surface.
  useLayoutEffect(() => {
    controllingRef.current = controlling;
  }, [controlling]);
  const run = useAtomCommand(backgroundTerminalEnvironment.control, { reportFailure: false });
  const terminalId = terminal.view.id;
  const control = async (command: Control) => {
    if (!permitted) throw new Error("Terminal control permission is required.");
    const request: DulliBackgroundTerminalControlInput = {
      ...command,
      threadId,
      managerId,
      terminalId,
      clientId,
    };
    const result = await run({ environmentId, input: request });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };
  // The terminal surface retains these handlers for its lifetime; changing control
  // permissions must not dispose the surface or lose its current selection.
  const reportError = useStableCallback((cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause)),
  );
  const resize = useStableCallback((cols: number, rows: number) => {
    if (controllingRef.current)
      void control({
        action: "resize",
        cols: Math.max(2, Math.min(500, cols)),
        rows: Math.max(1, Math.min(200, rows)),
      }).catch(reportError);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hold the server watch lease while the tab is visible, with a heartbeat and visibility listener until unmount.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const watch = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      void control({ action: "watch" })
        .then(
          () => {
            if (!cancelled && !document.hidden) setWatching(true);
          },
          (cause) => {
            if (!cancelled) {
              setWatching(false);
              reportError(cause);
            }
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    const visibility = () => {
      if (document.hidden) {
        setWatching(false);
        controllingRef.current = false;
        input.current?.dispose();
        void control({ action: "unwatch" }).catch(() => undefined);
      } else watch();
    };
    document.addEventListener("visibilitychange", visibility);
    watch();
    // A lease also releases control if a tab disappears without sending unwatch.
    const heartbeat = setInterval(watch, 15_000);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibility);
      controllingRef.current = false;
      void control({ action: "unwatch" }).catch(() => undefined);
    };
  }, [control, reportError]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hold a terminal input batcher only while owning the server PTY, discarding queued keys when ownership ends.
  useEffect(() => {
    if (!controlling) {
      input.current?.dispose();
      input.current = null;
      return;
    }
    const batcher = createTerminalInputBatcher(async (data) => {
      if (controllingRef.current) await control({ action: "send", data });
    }, reportError);
    input.current = batcher;
    const size = surface.current?.fittedDimensions;
    if (size) resize(size.cols, size.rows);
    surface.current?.focus();
    return () => {
      batcher.dispose();
      input.current = null;
    };
  }, [controlling, control, resize, reportError]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mount the imperative Ghostty DOM surface and theme observer, disposing both on unmount.
  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    let cancelled = false;
    void GhosttyTerminalSurface.create(element, {
      theme: terminalThemeFromApp(element),
      onData: (data) => {
        if (controllingRef.current) input.current?.push(data);
      },
      onResize: resize,
      beforeKey: (event) => {
        // Escape belongs to full-screen applications, not the surrounding sheet.
        if (controllingRef.current) event.stopPropagation();
        return controllingRef.current;
      },
      onSelectionChange: () => undefined,
      onLinkActivate: () => undefined,
    })
      .then((next) => {
        if (cancelled) {
          next.dispose();
          return;
        }
        surface.current = next;
        const screen = latest.current.screen;
        if (screen) {
          next.setGridSizeOverride(screen.cols, screen.rows);
          next.write(screenToVt(screen));
        }
        if (controllingRef.current) next.focus();
      })
      .catch(reportError);
    const observer = new MutationObserver(() =>
      surface.current?.setTheme(terminalThemeFromApp(element)),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      surface.current?.dispose();
      surface.current = null;
    };
  }, [resize, reportError]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Write server screen updates into the mounted Ghostty surface.
  useEffect(() => {
    if (!terminal.screen || !surface.current) return;
    surface.current.setGridSizeOverride(terminal.screen.cols, terminal.screen.rows);
    surface.current.write(screenToVt(terminal.screen));
  }, [terminal.screen]);

  const toggle = async () => {
    setPending(true);
    setError(null);
    // Discard unsent keys immediately; never replay input after releasing ownership.
    if (controlling) {
      controllingRef.current = false;
      input.current?.dispose();
    }
    try {
      await control({ action: controlling ? "release" : "attach" });
    } catch (cause) {
      reportError(cause);
    }
    setPending(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            pending ||
            !permitted ||
            !watching ||
            terminal.view.status !== "running" ||
            (!controlling && terminal.view.attached)
          }
          onClick={() => void toggle()}
        >
          {controlling
            ? "Release control"
            : terminal.view.attached
              ? "Controlled elsewhere"
              : "Take control"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {controlling ? "Keyboard connected" : "Read-only"}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {terminal.screen?.warning && (
        <p className="text-xs text-muted-foreground">{terminal.screen.warning}</p>
      )}
      <div
        ref={mount}
        role="group"
        aria-label="Interactive background terminal"
        className="relative min-h-48 flex-1 overflow-auto"
      />
    </div>
  );
}
