import { useAtomValue } from "@effect/atom-react";
import {
  dulliTranscriptEntries,
  dulliToolPreview,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type DulliInspectorAgent,
  type DulliTranscriptEntry,
} from "@t3tools/client-runtime/state/dulliSubagents";
import type {
  EnvironmentId,
  ThreadId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowLeft,
  Bot,
  Brain,
  FileText,
  FolderSearch,
  OctagonX,
  Send,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { agentStatusLabel, AgentElapsed, AgentStatusDot } from "./agentsPresentation";

function ToolGlyph({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  const Icon = normalized.includes("read")
    ? FileText
    : /list|glob|search|^ls$/u.test(normalized)
      ? FolderSearch
      : /bash|shell|exec/u.test(normalized)
        ? Terminal
        : Wrench;
  return <Icon aria-hidden className="size-3.5" />;
}

/** Tool detail mounts only when its card is in view, and only while expanded. */
function ToolCard({
  entry,
  environmentId,
}: {
  entry: Extract<DulliTranscriptEntry, { kind: "tool" }>;
  environmentId: EnvironmentId;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([record]) =>
      setVisible(record?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const detail = useEnvironmentQuery(
    visible && open && entry.source.outputOmitted
      ? orchestrationEnvironment.turnItem({
          environmentId,
          input: {
            threadId: entry.source.threadId,
            itemId: entry.source.id,
            revision: DateTime.formatIso(entry.source.updatedAt),
          },
        })
      : null,
  );
  const output =
    detail.data?.item?.type === "dynamic_tool"
      ? dulliToolPreview(detail.data.item.output)
      : entry.output;
  const failed = entry.status === "failed";
  return (
    <details
      ref={ref}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={cn(
        "rounded-lg border px-3 py-2",
        failed ? "border-destructive/35 bg-destructive/5" : "border-border/65 bg-card/30",
      )}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
        <ToolGlyph name={entry.name} />
        <span className="truncate">{entry.name}</span>
        <span
          className={cn(
            "ml-auto text-3xs font-normal",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {entry.live ? "Running" : entry.status === "completed" ? "Completed" : entry.status}
        </span>
      </summary>
      {entry.input ? (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-muted-foreground">
          {entry.input}
        </pre>
      ) : null}
      {output ? (
        <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-muted-foreground">
          {output}
        </pre>
      ) : null}
      {detail.isPending && !output ? (
        <p className="mt-1 text-xs text-muted-foreground">Loading tool output…</p>
      ) : null}
      {detail.error ? (
        <div role="alert" className="mt-1 text-xs text-destructive">
          {detail.error}
          <Button size="xs" variant="ghost" onClick={detail.refresh}>
            Retry output
          </Button>
        </div>
      ) : null}
    </details>
  );
}

function TranscriptEntry({
  entry,
  environmentId,
}: {
  entry: DulliTranscriptEntry;
  environmentId: EnvironmentId;
}) {
  if (entry.kind === "tool") return <ToolCard entry={entry} environmentId={environmentId} />;
  if (entry.kind === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted/55 px-3.5 py-2.5">
          <ChatMarkdown
            cwd={undefined}
            environmentId={environmentId}
            text={entry.text}
            parseRawHtml={false}
          />
        </div>
      </div>
    );
  if (entry.kind === "reasoning")
    return (
      <section className="flex gap-2.5 rounded-lg bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
        <Brain aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-3xs font-semibold uppercase tracking-wider">
            {entry.live ? "Thinking" : "Reasoning"}
          </p>
          <ChatMarkdown
            cwd={undefined}
            environmentId={environmentId}
            text={entry.text}
            isStreaming={entry.live}
            parseRawHtml={false}
          />
        </div>
      </section>
    );
  return (
    <div className="px-1">
      <ChatMarkdown
        cwd={undefined}
        environmentId={environmentId}
        text={entry.text}
        isStreaming={entry.live}
        parseRawHtml={false}
      />
    </div>
  );
}

function AgentComposer({
  agent,
  environmentId,
  threadId,
  enabled,
}: {
  agent: DulliInspectorAgent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  enabled: boolean;
}) {
  const permission = useAtomValue(threadEnvironment.controlTask.permissionAtom(environmentId));
  const controlTask = useAtomCommand(threadEnvironment.controlTask, { reportFailure: false });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const messageId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!enabled && !pending && !feedback) return null;
  const submit = async (action: "reply" | "stop") => {
    const taskId = agent.source.nativeTaskRef?.nativeId;
    if (
      !enabled ||
      !permission ||
      !taskId ||
      pending ||
      (action === "reply" && (agent.status !== "waiting" || !message.trim()))
    )
      return;
    setPending(true);
    setFeedback(null);
    const result = await controlTask({
      environmentId,
      input: {
        threadId,
        taskId,
        ...(action === "stop" ? { action } : { action, message: message.trim() }),
      },
    });
    if (!mounted.current) return;
    setPending(false);
    const success = AsyncResult.isSuccess(result);
    if (success) setMessage("");
    setFeedback({
      error: !success,
      text: success
        ? action === "reply"
          ? "Reply requested."
          : "Stop requested."
        : "The task control could not be delivered. The child may have ended or its extension is unavailable.",
    });
  };
  return (
    <form
      className="shrink-0 space-y-2 border-t border-border/65 bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit("reply");
      }}
    >
      {enabled && agent.status === "waiting" ? (
        <>
          <label htmlFor={messageId} className="sr-only">
            Reply to this agent
          </label>
          <Textarea
            id={messageId}
            size="sm"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Answer what this agent is waiting for…"
            rows={2}
            maxLength={32000}
            disabled={!permission || pending}
          />
        </>
      ) : null}
      {enabled ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!permission || pending}
            onClick={() => void submit("stop")}
          >
            <OctagonX aria-hidden />
            Stop agent
          </Button>
          {agent.status === "waiting" ? (
            <Button type="submit" size="sm" disabled={!permission || pending || !message.trim()}>
              <Send aria-hidden />
              Reply
            </Button>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Requesting…
        </p>
      ) : null}
      {feedback ? (
        <p
          role={feedback.error ? "alert" : "status"}
          className={cn("text-xs", feedback.error ? "text-destructive" : "text-muted-foreground")}
        >
          {feedback.text}
        </p>
      ) : null}
    </form>
  );
}

export function AgentDetail({
  agent,
  environmentId,
  threadId,
  controlsEnabled,
  revision,
  transcriptFor,
  onBack,
  backLabel = "Back to agent list",
}: {
  agent: DulliInspectorAgent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  controlsEnabled: boolean;
  revision: string | undefined;
  transcriptFor: (
    agent: OrchestrationV2Subagent,
    history?: ReadonlyArray<OrchestrationV2TurnItem>,
  ) => OrchestrationV2TurnItem[];
  onBack?: (() => void) | undefined;
  backLabel?: string;
}) {
  const history = useEnvironmentQuery(
    orchestrationEnvironment.subagentTranscript({
      environmentId,
      input: { threadId, subagentId: agent.source.id, revision },
    }),
  );
  const items = useMemo(
    () =>
      dulliTranscriptEntries(
        transcriptFor(agent.source, history.data?.items),
        agent.prompt,
        isActiveSubagentStatus(agent.status),
      ),
    [transcriptFor, agent.source, agent.prompt, agent.status, history.data?.items],
  );
  const resultAlreadyShown = items.some(
    (item) => item.kind === "assistant" && item.text.trim() === agent.result?.trim(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const content = contentRef.current;
    if (!viewport || !content) return;
    const track = () => {
      stick.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
    };
    const sync = () => {
      if (stick.current) viewport.scrollTop = viewport.scrollHeight;
    };
    viewport.addEventListener("scroll", track, { passive: true });
    const stop = observeResize([viewport, content], sync);
    sync();
    return () => {
      viewport.removeEventListener("scroll", track);
      stop();
    };
  }, []);
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
              aria-label={backLabel}
            >
              <ArrowLeft aria-hidden />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            {agent.workflowName || agent.phaseTitle ? (
              <p className="mb-0.5 flex items-center gap-1 text-3xs text-muted-foreground">
                <Workflow aria-hidden className="size-3 shrink-0" />
                <span className="truncate">
                  {[agent.workflowName, agent.phaseTitle].filter(Boolean).join(" / ")}
                </span>
              </p>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <AgentStatusDot status={agent.status} />
              <h2 className="min-w-0 truncate text-sm font-semibold">{agent.title}</h2>
              <span className="shrink-0 rounded-full border border-border/65 px-2 py-0.5 text-3xs text-muted-foreground">
                {agentStatusLabel(agent)}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-3xs text-muted-foreground">
              {formatSubagentModelLabel(agent.model, agent.effort) ?? "Provider default"} ·{" "}
              <AgentElapsed agent={agent} /> ·{" "}
              {agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok"}
              {agent.usage?.toolUses !== undefined ? ` · ${agent.usage.toolUses} tools` : ""}
            </p>
          </div>
        </div>
      </header>
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4"
          aria-label="Child transcript"
        >
          {agent.prompt ? (
            <TranscriptEntry
              environmentId={environmentId}
              entry={{ id: "prompt", kind: "user", text: agent.prompt, live: false }}
            />
          ) : null}
          {history.isPending && !history.data ? (
            <p className="text-xs text-muted-foreground">Loading transcript…</p>
          ) : null}
          {history.error ? (
            <div role="alert" className="text-xs text-destructive">
              {history.error}
              <Button variant="ghost" size="sm" onClick={history.refresh}>
                Retry transcript
              </Button>
            </div>
          ) : null}
          {items.map((entry) => (
            <TranscriptEntry key={entry.id} entry={entry} environmentId={environmentId} />
          ))}
          {agent.error ? (
            <section className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2.5">
              <h3 className="mb-1 text-xs font-semibold text-destructive">Agent failed</h3>
              <ChatMarkdown
                cwd={undefined}
                environmentId={environmentId}
                text={agent.error}
                parseRawHtml={false}
              />
            </section>
          ) : agent.result && !resultAlreadyShown ? (
            <section className="rounded-lg border border-border/65 px-3 py-2.5">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold">
                <Bot aria-hidden className="size-3.5" />
                Final result
              </h3>
              <ChatMarkdown
                cwd={undefined}
                environmentId={environmentId}
                text={agent.result}
                parseRawHtml={false}
              />
            </section>
          ) : null}
          {!items.length && !agent.result && !agent.error && !history.isPending ? (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Bot aria-hidden className="size-6" />
              <p className="text-sm font-medium">Waiting for agent activity</p>
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
