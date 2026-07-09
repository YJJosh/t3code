import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isSubagentRunActive,
  subagentRunNeedsInput,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, PiSubagentControlInput, ThreadId } from "@t3tools/contracts";
import { useCallback, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";

import { subagentEnvironment } from "../../state/subagents";
import { useAtomCommand } from "../../state/use-atom-command";

interface SubagentRunControlsProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  run: SubagentRunEntry;
}

function controlErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

export function SubagentRunControls({ environmentId, threadId, run }: SubagentRunControlsProps) {
  const runControl = useAtomCommand(subagentEnvironment.control, { reportFailure: false });
  const [pendingAction, setPendingAction] = useState<PiSubagentControlInput["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const messageFieldId = useId();
  const requestSequenceRef = useRef(0);

  const runId = run.view.runId;
  const isActive = isSubagentRunActive(run.view.state);
  const needsInput = subagentRunNeedsInput(run.view.state);
  const canSteer = isActive;
  const canReply = needsInput;
  const canKill = isActive || needsInput;

  const submit = useCallback(
    async (input: PiSubagentControlInput, fallback: string, clearMessage: boolean) => {
      setPendingAction(input.action);
      setError(null);
      try {
        const correlatedInput = {
          ...input,
          requestId:
            input.requestId ?? `${runId}:${messageFieldId}:${++requestSequenceRef.current}`,
        } satisfies PiSubagentControlInput;
        const result = await runControl({ environmentId, input: correlatedInput });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          setError(controlErrorMessage(squashAtomCommandFailure(result), fallback));
          return;
        }
        if (result._tag === "Success" && clearMessage) {
          setMessage("");
        }
      } finally {
        setPendingAction(null);
      }
    },
    [environmentId, messageFieldId, runControl, runId],
  );

  const trimmedMessage = message.trim();
  const messageAction = canReply ? "reply" : "steer";
  const busy = pendingAction !== null;
  const messageBusy = pendingAction === messageAction;
  const killBusy = pendingAction === "kill";

  if (!canSteer && !canReply && !canKill) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" data-slot="subagent-controls">
      {(canSteer || canReply) && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={messageFieldId} className="text-xs font-medium text-muted-foreground">
            {canReply ? "Reply to this run" : "Steer this run"}
          </label>
          <Textarea
            id={messageFieldId}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={2}
            placeholder={
              canReply ? "Answer the run's open question…" : "Send a steering message to the run…"
            }
            aria-label={canReply ? "Reply message" : "Steering message"}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={trimmedMessage.length === 0 || busy}
              onClick={() =>
                void submit(
                  canReply
                    ? { threadId, action: "reply", runId, message: trimmedMessage }
                    : { threadId, action: "steer", runId, message: trimmedMessage },
                  canReply ? "Failed to send reply." : "Failed to steer run.",
                  true,
                )
              }
            >
              {messageBusy ? <Spinner /> : null}
              {canReply ? "Send reply" : "Steer"}
            </Button>
          </div>
        </div>
      )}

      {canKill && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={() =>
              void submit(
                { threadId, action: "kill", runId, reason: "Stopped from the T3 client." },
                "Failed to stop run.",
                false,
              )
            }
          >
            {killBusy ? <Spinner /> : null}
            Stop run
          </Button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
