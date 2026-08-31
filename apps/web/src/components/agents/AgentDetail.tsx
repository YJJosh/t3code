import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ProviderTaskControlInput, ThreadId } from "@t3tools/contracts";
import { ArrowLeft, MessageSquareMore, OctagonX, Send, Workflow } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { AGENT_STATUS_VISUALS, AgentElapsed, AgentStatusDot } from "./agentsPresentation";

function DetailTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/35 px-2.5 py-2">
      <dt className="text-[.65rem] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 truncate text-xs font-medium text-foreground">{children}</dd>
    </div>
  );
}

function AgentMetadata({ agent }: { agent: RuntimeSubagent }) {
  const model = formatSubagentModelLabel(agent.model, agent.effort) ?? "Provider default";
  return (
    <dl className="grid grid-cols-2 gap-2">
      <DetailTile label="Model">{model}</DetailTile>
      <DetailTile label="Elapsed">
        <AgentElapsed agent={agent} />
      </DetailTile>
      <DetailTile label="Runs">
        {agent.activationCount}
        {agent.attempt !== null ? ` · attempt ${agent.attempt}` : ""}
      </DetailTile>
      <DetailTile label="Usage">
        {agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tokens` : "—"}
      </DetailTile>
    </dl>
  );
}

function UsageBreakdown({ agent }: { agent: RuntimeSubagent }) {
  if (!agent.usage) return null;
  const values = [
    agent.usage.inputTokens !== undefined ? `${agent.usage.inputTokens} input` : null,
    agent.usage.cachedInputTokens !== undefined ? `${agent.usage.cachedInputTokens} cached` : null,
    agent.usage.outputTokens !== undefined ? `${agent.usage.outputTokens} output` : null,
    agent.usage.reasoningOutputTokens !== undefined
      ? `${agent.usage.reasoningOutputTokens} reasoning`
      : null,
    agent.usage.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
  ].filter((value): value is string => value !== null);
  return values.length > 0 ? (
    <p className="font-mono text-[.7rem] text-muted-foreground">{values.join(" · ")}</p>
  ) : null;
}

function AgentControls({
  agent,
  environmentId,
  threadId,
  enabled,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  enabled: boolean;
}) {
  const controlTask = useAtomCommand(threadEnvironment.controlTask, { reportFailure: false });
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<ProviderTaskControlInput["action"] | null>(
    null,
  );
  const [controlStatus, setControlStatus] = useState<{
    tone: "error" | "status";
    message: string;
  } | null>(null);
  const messageId = useId();

  useEffect(() => {
    setMessage("");
    setPendingAction(null);
    setControlStatus(null);
  }, [agent.id]);

  const canControl =
    enabled &&
    environmentId !== null &&
    threadId !== null &&
    agent.kind !== "workflow" &&
    !isTerminalSubagentStatus(agent.status) &&
    agent.status !== "idle";
  if (!canControl) return null;

  const messageAction = agent.status === "waiting" ? "reply" : "steer";
  const submitControl = async (
    input:
      | { readonly action: "steer" | "reply"; readonly message: string }
      | { readonly action: "stop"; readonly reason?: string },
  ) => {
    if (environmentId === null || threadId === null) return;
    setPendingAction(input.action);
    setControlStatus(null);
    const result = await controlTask({
      environmentId,
      input: { threadId, taskId: agent.id, ...input } as ProviderTaskControlInput,
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      setControlStatus({ tone: "error", message: "The task control could not be delivered." });
      return;
    }
    setMessage("");
    setControlStatus({
      tone: "status",
      message:
        input.action === "stop"
          ? "Stop requested."
          : input.action === "reply"
            ? "Reply requested."
            : "Steering requested.",
    });
  };

  return (
    <section className="space-y-2 rounded-lg border border-border/65 p-3">
      <label htmlFor={messageId} className="flex items-center gap-2 text-xs font-semibold">
        <MessageSquareMore aria-hidden className="size-3.5" />
        {messageAction === "reply" ? "Answer requested input" : "Steer this agent"}
      </label>
      <Textarea
        id={messageId}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={
          messageAction === "reply"
            ? "Send the answer the agent is waiting for…"
            : "Send guidance between the agent's turns…"
        }
        rows={3}
        disabled={pendingAction !== null}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={message.trim().length === 0 || pendingAction !== null}
          onClick={() => void submitControl({ action: messageAction, message: message.trim() })}
        >
          <Send aria-hidden className="size-3.5" />
          {pendingAction === messageAction
            ? "Sending…"
            : messageAction === "reply"
              ? "Reply"
              : "Steer"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pendingAction !== null}
          onClick={() => void submitControl({ action: "stop" })}
        >
          <OctagonX aria-hidden className="size-3.5" />
          {pendingAction === "stop" ? "Stopping…" : "Stop agent"}
        </Button>
      </div>
      {controlStatus ? (
        <p
          role={controlStatus.tone === "error" ? "alert" : "status"}
          className={
            controlStatus.tone === "error"
              ? "text-xs text-destructive-foreground"
              : "text-xs text-muted-foreground"
          }
        >
          {controlStatus.message}
        </p>
      ) : null}
    </section>
  );
}

export function AgentDetail({
  agent,
  environmentId,
  threadId,
  controlsEnabled,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  controlsEnabled: boolean;
  onBack?: (() => void) | undefined;
}) {
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const handles = agent.runHandles
    ? [
        ["Run", agent.runHandles.runId],
        ["Session", agent.runHandles.sessionUrl],
        ["Transcript", agent.runHandles.transcriptDir],
        ["Script", agent.runHandles.scriptPath],
      ].filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      )
    : [];

  return (
    <ScrollArea className="min-h-0 flex-1" data-agent-detail={agent.id}>
      <div className="flex flex-col gap-4 p-4">
        <header className="flex min-w-0 items-start gap-2">
          {onBack ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
              autoFocus
              aria-label="Back to agent list"
              className="-ml-1 shrink-0"
            >
              <ArrowLeft aria-hidden />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            {agent.workflowName || agent.phaseTitle ? (
              <p className="mb-1 flex min-w-0 items-center gap-1 text-[.7rem] text-muted-foreground">
                <Workflow aria-hidden className="size-3 shrink-0" />
                {agent.workflowName ? <span className="truncate">{agent.workflowName}</span> : null}
                {agent.workflowName && agent.phaseTitle ? <span aria-hidden>/</span> : null}
                {agent.phaseTitle ? <span className="truncate">{agent.phaseTitle}</span> : null}
              </p>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <AgentStatusDot status={agent.status} />
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                {agent.title}
              </h2>
              <span className="shrink-0 rounded-full border border-border/65 px-2 py-0.5 text-[.65rem] text-muted-foreground">
                {visuals.label}
              </span>
            </div>
            {role ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{role}</p> : null}
            <p
              className="mt-1 truncate font-mono text-[.65rem] text-muted-foreground"
              title={agent.id}
            >
              {agent.id}
            </p>
          </div>
        </header>

        <AgentMetadata agent={agent} />
        <UsageBreakdown agent={agent} />

        {agent.status === "waiting" ? (
          <section className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-foreground">Waiting on input</h3>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {agent.progress ??
                agent.recentActivity.at(-1)?.summary ??
                "This agent needs a reply."}
            </p>
          </section>
        ) : agent.progress ? (
          <section className="rounded-lg border border-info/25 bg-info/5 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-foreground">Progress</h3>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{agent.progress}</p>
          </section>
        ) : null}

        {agent.error ? (
          <section className="rounded-lg border border-destructive/35 bg-destructive/6 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-destructive-foreground">Error</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-destructive-foreground">
              {agent.error}
            </p>
          </section>
        ) : null}
        {agent.result ? (
          <section className="rounded-lg border border-border/65 px-3 py-2.5 text-xs">
            <h3 className="font-semibold text-foreground">Result</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
              {agent.result}
            </p>
          </section>
        ) : null}
        {agent.outputFile ? (
          <section className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
            <h3 className="font-semibold text-foreground">Output</h3>
            <p className="mt-1 break-all font-mono text-[.7rem] text-muted-foreground">
              {agent.outputFile}
            </p>
          </section>
        ) : null}

        {agent.recentActivity.length > 0 ? (
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground">Recent activity</h3>
              <span className="text-[.65rem] text-muted-foreground">Latest events</span>
            </div>
            <ol className="space-y-1 rounded-lg border border-border/65 p-2">
              {agent.recentActivity.map((entry) => (
                <li
                  key={`${entry.at}:${entry.summary}`}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/35"
                >
                  <time
                    className="truncate font-mono text-[.65rem] text-muted-foreground"
                    dateTime={entry.at}
                  >
                    {entry.at}
                  </time>
                  <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/90">
                    {entry.summary}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {handles.length > 0 ? (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-foreground">Run details</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-border/65 px-3 py-2 text-xs">
              {handles.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-all font-mono text-[.7rem] text-foreground/90">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <AgentControls
          agent={agent}
          environmentId={environmentId}
          threadId={threadId}
          enabled={controlsEnabled}
        />
      </div>
    </ScrollArea>
  );
}
