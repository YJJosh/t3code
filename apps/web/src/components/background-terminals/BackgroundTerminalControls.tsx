import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isBackgroundTerminalActive,
  type BackgroundTerminalEntry,
} from "@t3tools/client-runtime/state/background-terminals";
import type {
  EnvironmentId,
  DulliBackgroundTerminalControlInput,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useId, useRef, useState } from "react";

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

/** Stops a running shared terminal. Starting and interactive ownership live
 * in the panel and PTY controls, not in this small lifecycle action. */
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

  const permitted = useAtomValue(
    backgroundTerminalEnvironment.control.permissionAtom(environmentId),
  );
  const terminalId = terminal.view.id;
  const canKill = isBackgroundTerminalActive(terminal.view.status);

  const kill = async () => {
    setPending(true);
    setError(null);
    const input: DulliBackgroundTerminalControlInput = {
      threadId,
      action: "kill",
      terminalId,
      managerId,
      requestId: `${terminalId}:${requestFieldId}:${++requestSequenceRef.current}`,
    };
    // Atom commands settle thrown errors into the result, so this always runs.
    const result = await runControl({ environmentId, input });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(controlErrorMessage(squashAtomCommandFailure(result), "Failed to stop terminal."));
    }
  };

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
          disabled={pending || !permitted}
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
