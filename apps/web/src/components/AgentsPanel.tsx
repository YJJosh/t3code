import { useAtomValue } from "@effect/atom-react";
import {
  deriveDulliAgentInspector,
  dulliTranscriptText,
} from "@t3tools/client-runtime/state/dulliSubagents";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

/** The fork's roster/detail inspector, backed by Pi-owned runs and lazy transcripts. */
export function AgentsPanel({
  environmentId,
  projection,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
}) {
  const model = useMemo(() => deriveDulliAgentInspector(projection), [projection]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = model.agents.find((agent) => agent.id === selectedId) ?? null;
  const transcript = useEnvironmentQuery(
    selected
      ? orchestrationEnvironment.subagentTranscript({
          environmentId,
          input: {
            threadId: projection.thread.id,
            subagentId: selected.id,
            revision: model.revision(selected.id),
          },
        })
      : null,
  );
  const permission = useAtomValue(threadEnvironment.controlTask.permissionAtom(environmentId));
  const control = useAtomCommand(threadEnvironment.controlTask);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const select = (agent: OrchestrationV2Subagent) => {
    setSelectedId(agent.id);
    setMessage("");
    setError(null);
  };
  const act = async (action: "steer" | "reply" | "stop") => {
    if (!selected?.nativeTaskRef?.nativeId || pending) return;
    setPending(true);
    setError(null);
    const result = await control({
      environmentId,
      input: {
        threadId: projection.thread.id,
        taskId: selected.nativeTaskRef.nativeId,
        ...(action === "stop" ? { action } : { action, message: message.trim() }),
      },
    });
    setPending(false);
    if (AsyncResult.isSuccess(result)) setMessage("");
    else
      setError("Child control failed. The child may have ended or its extension is unavailable.");
  };
  const row = (agent: OrchestrationV2Subagent) => (
    <button
      key={agent.id}
      type="button"
      aria-pressed={agent.id === selectedId}
      className="w-full rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:outline-2"
      onClick={() => select(agent)}
    >
      <span className="block truncate text-sm font-medium">
        {agent.title || agent.prompt || "Agent"}
      </span>
      <span className="block text-xs text-muted-foreground">
        {agent.status} · {agent.model ?? "Provider default"}
      </span>
    </button>
  );
  return (
    <section className="@container flex min-h-0 flex-1 flex-col" aria-label="Agents and workflows">
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Agents roster"
          className={`${selected ? "hidden @2xl:block" : "block"} w-full overflow-y-auto border-r @2xl:w-64 @2xl:shrink-0`}
        >
          <h2 className="px-3 py-3 font-semibold">Agents & workflows</h2>
          {model.groups.length === 0 ? (
            <p className="px-3 text-sm text-muted-foreground">No Dulli subagents yet.</p>
          ) : null}
          {model.groups.map((group) => (
            <section key={group.id}>
              <h3 className="truncate px-3 py-2 text-xs text-muted-foreground">{group.prompt}</h3>
              {group.agents.map(row)}
            </section>
          ))}
        </nav>
        {selected ? (
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 @2xl:hidden">
              <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                Back to agents
              </Button>
            </div>
            <h2 className="truncate font-semibold" title={selected.title || undefined}>
              {selected.title || "Agent"}
            </h2>
            <p className="my-2 text-xs text-muted-foreground">
              {selected.status} · {selected.model ?? "Provider default"}
              {selected.modelSelection?.options?.find((option) => option.id === "reasoning")?.value
                ? ` · ${selected.modelSelection.options.find((option) => option.id === "reasoning")!.value}`
                : ""}
              {selected.usage
                ? ` · ${selected.usage.totalTokens.toLocaleString()} tokens · ${selected.usage.toolUses ?? 0} tools`
                : ""}
            </p>
            <details className="mb-4" open>
              <summary className="text-sm font-medium">Original prompt</summary>
              <p className="whitespace-pre-wrap text-sm">{selected.prompt}</p>
            </details>
            {selected.workflow ? (
              <section aria-label="Workflow phases" className="mb-4">
                <h3 className="mb-2 font-medium">{selected.workflow.name ?? "Workflow"}</h3>
                {selected.workflow.phases.map((phase) => (
                  <div key={phase.index} className="border-l pl-3">
                    <h4 className="py-1 text-sm font-medium">{phase.title}</h4>
                    {model
                      .children(selected)
                      .filter((child) =>
                        selected.workflow!.agents.some(
                          (member) =>
                            member.agentId === child.nativeTaskRef?.nativeId &&
                            member.phaseIndex === phase.index,
                        ),
                      )
                      .map(row)}
                  </div>
                ))}
                {model
                  .children(selected)
                  .filter(
                    (child) =>
                      !selected.workflow!.agents.some(
                        (member) =>
                          member.agentId === child.nativeTaskRef?.nativeId &&
                          member.phaseIndex !== undefined,
                      ),
                  )
                  .map(row)}
              </section>
            ) : null}
            {selected.progress ? (
              <p className="mb-3 text-sm text-muted-foreground">{selected.progress}</p>
            ) : null}
            {transcript.isPending && !transcript.data ? (
              <p className="text-sm text-muted-foreground">Loading transcript…</p>
            ) : null}
            {transcript.error ? (
              <div role="alert">
                <p className="text-sm text-destructive">{transcript.error}</p>
                <Button variant="ghost" size="sm" onClick={transcript.refresh}>
                  Retry transcript
                </Button>
              </div>
            ) : null}
            <div aria-label="Child transcript" className="space-y-3">
              {model.transcript(selected, transcript.data?.items).map((item) => (
                <article key={item.id}>
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {item.type === "reasoning"
                      ? "Thinking"
                      : item.type === "dynamic_tool"
                        ? `${item.toolName ?? "Tool"} · ${item.status}`
                        : item.type === "user_message"
                          ? "User"
                          : "Assistant"}
                  </h4>
                  <ChildTranscriptText item={item} environmentId={environmentId} />
                </article>
              ))}
            </div>
            {selected.result ? (
              <section className="mt-4">
                <h3 className="text-sm font-medium">
                  {selected.status === "failed" ? "Error" : "Result"}
                </h3>
                <p className="whitespace-pre-wrap text-sm">{selected.result}</p>
              </section>
            ) : null}
            {model.canControl(selected) ? (
              <form
                className="mt-4 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(selected.status === "waiting" ? "reply" : "steer");
                }}
              >
                <label className="block text-sm" htmlFor="dulli-child-message">
                  {selected.status === "waiting" ? "Reply to agent" : "Steer agent"}
                </label>
                <textarea
                  id="dulli-child-message"
                  className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
                  value={message}
                  maxLength={32000}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={!permission || pending}
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!permission || pending || !message.trim()}
                  >
                    {selected.status === "waiting" ? "Reply" : "Steer"}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!permission || pending}
                    onClick={() => void act("stop")}
                  >
                    Stop agent
                  </Button>
                </div>
              </form>
            ) : null}
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="hidden p-4 text-sm text-muted-foreground @2xl:block">
            Select an agent or workflow.
          </p>
        )}
      </div>
    </section>
  );
}

function ChildTranscriptText({
  item,
  environmentId,
}: {
  item: OrchestrationV2TurnItem;
  environmentId: EnvironmentId;
}) {
  // Parent streams intentionally withhold tool output. Fetch just the changed
  // tool's bounded detail, not the child's entire transcript on every delta.
  const detail = useEnvironmentQuery(
    item.type === "dynamic_tool" && item.outputOmitted
      ? orchestrationEnvironment.turnItem({
          environmentId,
          input: {
            threadId: item.threadId,
            itemId: item.id,
            revision: DateTime.formatIso(item.updatedAt),
          },
        })
      : null,
  );
  return (
    <pre className="whitespace-pre-wrap break-words text-sm">
      {dulliTranscriptText(detail.data?.item ?? item)}
    </pre>
  );
}
