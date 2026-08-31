import type {
  RuntimeSubagent,
  SubagentLiveTool,
  SubagentTranscriptItem,
  SubagentTranscriptPart,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ProviderTaskControlInput, ThreadId } from "@t3tools/contracts";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  FileText,
  FolderSearch,
  OctagonX,
  Send,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { AGENT_STATUS_VISUALS, AgentElapsed, AgentStatusDot } from "./agentsPresentation";

function ToolGlyph({ name }: { name: string }) {
  const normalized = name.toLocaleLowerCase();
  const Icon = normalized.includes("read")
    ? FileText
    : normalized.includes("list") || normalized === "ls" || normalized.includes("glob")
      ? FolderSearch
      : normalized.includes("bash") || normalized.includes("shell") || normalized.includes("exec")
        ? Terminal
        : Wrench;
  return <Icon aria-hidden className="size-3.5" />;
}

function ReasoningBlock({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <section className="flex gap-2.5 rounded-lg bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
      <Brain aria-hidden className={cn("mt-0.5 size-4 shrink-0", live && "text-info-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground/75">
          {live ? "Thinking" : "Reasoning"}
        </p>
        <ChatMarkdown
          cwd={undefined}
          text={text}
          isStreaming={live}
          parseRawHtml={false}
          className="text-muted-foreground italic"
        />
      </div>
    </section>
  );
}

function ToolCallCard({
  part,
  live = false,
}: {
  part: Extract<SubagentTranscriptPart, { type: "toolCall" }>;
  live?: boolean;
}) {
  return (
    <section className="rounded-lg border border-border/65 bg-card/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <ToolGlyph name={part.name} />
        <span className="truncate">{part.name}</span>
        {live ? (
          <span className="ml-auto text-[.65rem] font-normal text-info-foreground">Running</span>
        ) : (
          <Check aria-hidden className="ml-auto size-3.5 text-success-foreground" />
        )}
      </div>
      {part.argsPreview ? (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-muted-foreground">
          {part.argsPreview}
        </pre>
      ) : null}
    </section>
  );
}

function LiveToolCard({ tool }: { tool: SubagentLiveTool }) {
  return (
    <ToolCallCard
      live
      part={{
        type: "toolCall",
        id: tool.id,
        name: tool.name,
        ...(tool.outputPreview || tool.argsPreview
          ? { argsPreview: tool.outputPreview ?? tool.argsPreview }
          : {}),
      }}
    />
  );
}

function ToolResultCard({
  item,
}: {
  item: Extract<SubagentTranscriptItem, { kind: "toolResult" }>;
}) {
  return (
    <section
      className={cn(
        "rounded-lg border px-3 py-2",
        item.isError ? "border-destructive/35 bg-destructive/5" : "border-border/55 bg-muted/15",
      )}
    >
      <div className="flex items-center gap-2 text-xs font-semibold">
        <ToolGlyph name={item.name} />
        <span>{item.name}</span>
        <span
          className={cn(
            "ml-auto text-[.65rem] font-normal",
            item.isError ? "text-destructive-foreground" : "text-success-foreground",
          )}
        >
          {item.isError ? "Failed" : "Completed"}
        </span>
      </div>
      {item.outputPreview ? (
        <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-muted-foreground">
          {item.outputPreview}
        </pre>
      ) : null}
    </section>
  );
}

function AssistantPart({ part }: { part: SubagentTranscriptPart }) {
  if (part.type === "thinking") {
    return <ReasoningBlock text={part.redacted ? "[redacted reasoning]" : part.text} />;
  }
  if (part.type === "toolCall") return <ToolCallCard part={part} />;
  return (
    <div className="px-1">
      <ChatMarkdown cwd={undefined} text={part.text} parseRawHtml={false} />
    </div>
  );
}

function TranscriptItem({ item }: { item: SubagentTranscriptItem }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted/55 px-3.5 py-2.5">
          <ChatMarkdown cwd={undefined} text={item.text} parseRawHtml={false} />
        </div>
      </div>
    );
  }
  if (item.kind === "toolResult") return <ToolResultCard item={item} />;
  return (
    <div className="space-y-2.5">
      {item.parts.map((part, index) => (
        <AssistantPart key={`${part.type}:${"id" in part ? part.id : index}`} part={part} />
      ))}
    </div>
  );
}

function AgentComposer({
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
    <div className="shrink-0 border-t border-border/65 bg-background p-3">
      <div className="relative rounded-xl border border-border/70 bg-card/30 p-2 shadow-sm">
        <label htmlFor={messageId} className="sr-only">
          {messageAction === "reply" ? "Reply to this agent" : "Steer this agent"}
        </label>
        <Textarea
          id={messageId}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            messageAction === "reply"
              ? "Answer what this agent is waiting for…"
              : "Send guidance to this agent…"
          }
          rows={2}
          disabled={pendingAction !== null}
          className="min-h-14 resize-none border-0 bg-transparent pr-20 shadow-none focus-visible:ring-0"
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
          <Button
            type="button"
            size="icon-sm"
            variant="destructive"
            disabled={pendingAction !== null}
            onClick={() => void submitControl({ action: "stop" })}
            aria-label="Stop agent"
          >
            <OctagonX aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            disabled={message.trim().length === 0 || pendingAction !== null}
            onClick={() => void submitControl({ action: messageAction, message: message.trim() })}
            aria-label={messageAction === "reply" ? "Reply" : "Steer"}
          >
            <Send aria-hidden />
          </Button>
        </div>
      </div>
      {controlStatus ? (
        <p
          role={controlStatus.tone === "error" ? "alert" : "status"}
          className={cn(
            "mt-1.5 px-1 text-xs",
            controlStatus.tone === "error"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
          )}
        >
          {controlStatus.message}
        </p>
      ) : null}
    </div>
  );
}

export function AgentDetail({
  agent,
  environmentId,
  threadId,
  controlsEnabled,
  onBack,
  backLabel = "Back to agent list",
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  controlsEnabled: boolean;
  onBack?: (() => void) | undefined;
  backLabel?: string;
}) {
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const model = formatSubagentModelLabel(agent.model, agent.effort) ?? "Provider default";
  const promptAlreadyShown = agent.prompt
    ? agent.transcript.items.some(
        (item) => item.kind === "user" && item.text.trim() === agent.prompt?.trim(),
      )
    : false;
  const resultAlreadyShown = agent.result
    ? agent.transcript.items.some(
        (item) =>
          item.kind === "assistant" &&
          item.parts.some(
            (part) => part.type === "text" && part.text.trim() === agent.result?.trim(),
          ),
      )
    : false;

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [agent.id]);

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    const trackPosition = () => {
      stickToBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
    };
    viewport.addEventListener("scroll", trackPosition, { passive: true });
    return () => viewport.removeEventListener("scroll", trackPosition);
  }, [agent.id]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [
    agent.id,
    agent.updatedAt,
    agent.transcript.items.length,
    agent.transcript.liveAssistant,
    agent.transcript.liveTools,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agent-detail={agent.id}>
      <header className="shrink-0 border-b border-border/65 px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          {onBack ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
              autoFocus
              aria-label={backLabel}
              className="-ml-1 shrink-0"
            >
              <ArrowLeft aria-hidden />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            {agent.workflowName || agent.phaseTitle ? (
              <p className="mb-0.5 flex min-w-0 items-center gap-1 text-[.65rem] text-muted-foreground">
                <Workflow aria-hidden className="size-3 shrink-0" />
                {agent.workflowName ? <span className="truncate">{agent.workflowName}</span> : null}
                {agent.workflowName && agent.phaseTitle ? <span aria-hidden>/</span> : null}
                {agent.phaseTitle ? <span className="truncate">{agent.phaseTitle}</span> : null}
              </p>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <AgentStatusDot status={agent.status} />
              <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {agent.title}
              </h2>
              <span className="shrink-0 rounded-full border border-border/65 px-2 py-0.5 text-[.65rem] text-muted-foreground">
                {visuals.label}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[.65rem] text-muted-foreground">
              {model} · <AgentElapsed agent={agent} /> ·{" "}
              {agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok"}
              {agent.usage?.toolUses !== undefined ? ` · ${agent.usage.toolUses} tools` : ""}
            </p>
          </div>
        </div>
      </header>

      <ScrollArea ref={scrollAreaRef} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
          {agent.transcript.droppedItems > 0 ? (
            <p className="text-center text-xs text-muted-foreground">
              {agent.transcript.droppedItems} earlier transcript items omitted
            </p>
          ) : null}
          {!promptAlreadyShown && agent.prompt ? (
            <TranscriptItem
              item={{ sourceId: "originating-prompt", kind: "user", text: agent.prompt }}
            />
          ) : null}
          {agent.transcript.items.map((item) => (
            <TranscriptItem key={item.sourceId} item={item} />
          ))}
          {agent.transcript.liveAssistant?.thinking ? (
            <ReasoningBlock text={agent.transcript.liveAssistant.thinking} live />
          ) : null}
          {agent.transcript.liveAssistant?.text ? (
            <div className="px-1">
              <ChatMarkdown
                cwd={undefined}
                text={agent.transcript.liveAssistant.text}
                isStreaming
                parseRawHtml={false}
              />
            </div>
          ) : null}
          {agent.transcript.liveTools.map((tool) => (
            <LiveToolCard key={tool.id} tool={tool} />
          ))}
          {agent.error ? (
            <section className="rounded-lg border border-destructive/35 bg-destructive/6 px-3 py-2.5">
              <h3 className="text-xs font-semibold text-destructive-foreground">Agent failed</h3>
              <ChatMarkdown
                cwd={undefined}
                text={agent.error}
                parseRawHtml={false}
                className="mt-1 text-destructive-foreground"
              />
            </section>
          ) : agent.result && !resultAlreadyShown ? (
            <section className="rounded-lg border border-border/65 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-foreground">
                <Bot aria-hidden className="size-3.5" />
                Final result
              </div>
              <ChatMarkdown cwd={undefined} text={agent.result} parseRawHtml={false} />
            </section>
          ) : null}
          {agent.transcript.items.length === 0 && !agent.prompt && !agent.result && !agent.error ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Bot aria-hidden className="size-6 opacity-50" />
              <p className="text-sm font-medium text-foreground">Waiting for agent activity</p>
              <p className="max-w-72 text-xs">
                Reasoning, messages, and tool calls will appear here as this agent works.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <AgentComposer
        agent={agent}
        environmentId={environmentId}
        threadId={threadId}
        enabled={controlsEnabled}
      />
    </div>
  );
}
