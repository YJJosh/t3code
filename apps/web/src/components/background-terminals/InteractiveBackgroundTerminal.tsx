import type { BackgroundTerminalEntry } from "@t3tools/client-runtime/state/background-terminals";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PiBackgroundTerminalControlInput, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  const [clientId] = useState(() => randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [watching, setWatching] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const surface = useRef<GhosttyTerminalSurface | null>(null);
  const input = useRef<ReturnType<typeof createTerminalInputBatcher> | null>(null);
  const latest = useRef(terminal);
  useLayoutEffect(() => {
    latest.current = terminal;
  }, [terminal]);
  const controlling = terminal.view.controller === clientId && terminal.view.status === "running";
  const controllingRef = useRef(controlling);
  useLayoutEffect(() => {
    controllingRef.current = controlling;
  }, [controlling]);
  const run = useAtomCommand(backgroundTerminalEnvironment.control, { reportFailure: false });
  const terminalId = terminal.view.id;
  const control = useCallback(
    async (command: Control) => {
      const request: PiBackgroundTerminalControlInput = {
        ...command,
        threadId,
        managerId,
        terminalId,
        clientId,
      };
      const result = await run({ environmentId, input: request });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    [run, environmentId, threadId, managerId, terminalId, clientId],
  );
  const reportError = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const resize = useCallback(
    (cols: number, rows: number) => {
      if (controllingRef.current)
        void control({
          action: "resize",
          cols: Math.max(2, Math.min(500, cols)),
          rows: Math.max(1, Math.min(200, rows)),
        }).catch(reportError);
    },
    [control, reportError],
  );

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
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            pending ||
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
