import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isBackgroundTerminalActive,
  type BackgroundTerminalEntry,
} from "@t3tools/client-runtime/state/background-terminals";
import type { EnvironmentId, PiBackgroundTerminalControlInput, ThreadId } from "@t3tools/contracts";
import { useCallback, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

import { backgroundTerminalEnvironment } from "../../state/backgroundTerminals";
import { useAtomCommand } from "../../state/use-atom-command";

interface BackgroundTerminalControlsProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  managerId: string;
  terminal: BackgroundTerminalEntry;
}

function controlErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

/**
 * Kill-only control surface for a background terminal. There is no
 * start/restart/stdin path here by design — background terminals are
 * spawned by Pi, not by the client, so the only lifecycle action available
 * from this UI is stopping a still-running one.
 */
export function BackgroundTerminalControls({
  environmentId,
  threadId,
  managerId,
  terminal,
}: BackgroundTerminalControlsProps) {
  const runControl = useAtomCommand(backgroundTerminalEnvironment.control, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestFieldId = useId();
  const requestSequenceRef = useRef(0);

  const terminalId = terminal.view.id;
  const canKill = isBackgroundTerminalActive(terminal.view.status);

  const kill = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const input: PiBackgroundTerminalControlInput = {
        threadId,
        action: "kill",
        terminalId,
        managerId,
        requestId: `${terminalId}:${requestFieldId}:${++requestSequenceRef.current}`,
      };
      const result = await runControl({ environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(controlErrorMessage(squashAtomCommandFailure(result), "Failed to stop terminal."));
      }
    } finally {
      setPending(false);
    }
  }, [environmentId, managerId, requestFieldId, runControl, terminalId, threadId]);

  if (!canKill) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" data-slot="background-terminal-controls">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          disabled={pending}
          onClick={() => void kill()}
        >
          {pending ? <Spinner /> : null}
          Stop terminal
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
