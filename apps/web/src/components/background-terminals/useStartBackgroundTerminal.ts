import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PiBackgroundTerminalControlInput, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { backgroundTerminalEnvironment } from "../../state/backgroundTerminals";
import { useAtomCommand } from "../../state/use-atom-command";

export interface StartBackgroundTerminalOptions {
  readonly command: string;
  readonly title?: string;
  /** PTY terminal (default). Pipe terminals only capture output. */
  readonly interactive?: boolean;
  /** Keep a local shell open after the command exits (POSIX only). */
  readonly keepOpen?: boolean;
}

export type StartBackgroundTerminalResult =
  | { readonly requestId: string }
  | { readonly error: string };

export const BACKGROUND_TERMINAL_START_UNAVAILABLE =
  "Pi is not running in this thread yet. Send a message first, then start a terminal.";

/**
 * Starts a shared terminal inside the thread's live Pi session through the
 * background-terminal control channel. The server only acknowledges the
 * control; the new terminal's id arrives in the runtime state as a
 * `control_result` carrying the returned request id, which callers use to
 * select it once it exists.
 */
export function useStartBackgroundTerminal(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly managerId: string | null;
}) {
  const { environmentId, threadId, managerId } = input;
  const runControl = useAtomCommand(backgroundTerminalEnvironment.control, {
    reportFailure: false,
  });
  const sequenceRef = useRef(0);
  const available = environmentId !== null && threadId !== null && managerId !== null;

  const start = useCallback(
    async (options: StartBackgroundTerminalOptions): Promise<StartBackgroundTerminalResult> => {
      if (environmentId === null || threadId === null || managerId === null) {
        return { error: BACKGROUND_TERMINAL_START_UNAVAILABLE };
      }
      const command = options.command.trim();
      if (command.length === 0) {
        return { error: "Enter a command to run." };
      }
      sequenceRef.current += 1;
      const requestId = `start:${Date.now().toString(36)}:${sequenceRef.current}`;
      const title = options.title?.trim();
      const control: PiBackgroundTerminalControlInput = {
        threadId,
        action: "start",
        managerId,
        requestId,
        command,
        ...(title ? { title } : {}),
        interactive: options.interactive ?? true,
        ...(options.keepOpen ? { keepOpen: true } : {}),
      };
      const result = await runControl({ environmentId, input: control });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return { error: "Starting the terminal was interrupted." };
        }
        const cause = squashAtomCommandFailure(result);
        return {
          error:
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message
              : "Failed to start terminal.",
        };
      }
      return { requestId };
    },
    [environmentId, managerId, runControl, threadId],
  );

  return { start, available };
}
