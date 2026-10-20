import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  agentActivityText,
  deriveDulliAgentInspector,
  dulliTranscriptEntries,
  dulliToolPreview,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type DulliInspectorAgent,
  type DulliInspectorWorkflowGroup,
  type DulliTranscriptEntry,
} from "@t3tools/client-runtime/state/dulliSubagents";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { RequestActionButton } from "./RequestActionButton";
import {
  formatSubagentDuration,
  subagentStatusLabel,
  subagentStatusTone,
} from "./subagents/subagentPresentation";

type Target = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
function useInspector(target: Target) {
  const thread = useAtomValue(environmentThreadDetails.threadAtom(target));
  return useMemo(() => (thread ? deriveDulliAgentInspector(thread.projection) : null), [thread]);
}
const DOT_CLASS = {
  info: "bg-blue-500",
  warning: "bg-amber-500",
  success: "bg-green-500",
  error: "bg-red-500",
  muted: "bg-foreground-muted",
} as const;
function StatusDot({ agent }: { agent: DulliInspectorAgent }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[subagentStatusTone(agent.status)])}
    />
  );
}
function metadata(agent: DulliInspectorAgent) {
  return [
    formatSubagentModelLabel(agent.model, agent.effort) ?? "Provider default",
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Pi-owned chips stay separate from T3-owned agent rows. No ticking React state. */
export function DulliSubagentRows({ target }: { target: Target }) {
  const inspector = useInspector(target);
  const navigation = useNavigation();
  if (!inspector?.agents.length) return null;
  return (
    <View accessibilityLabel="Dulli agent runs" className="shrink-0 pb-2">
      <ScrollView
        horizontal
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {inspector.presentation.agents.map((agent) => (
          <Pressable
            key={agent.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${agent.title}, ${subagentStatusLabel(agent.status)}`}
            accessibilityHint="Opens agent run details"
            onPress={() => {
              void Haptics.selectionAsync();
              navigation.navigate("ThreadAgents", { ...target, subagentId: agent.id });
            }}
            className="min-h-11 max-w-60 flex-row items-center gap-2 rounded-xl border border-border bg-card-translucent px-3 py-2 active:bg-subtle-strong"
          >
            <StatusDot agent={agent} />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs font-t3-medium">
              {agent.title}
            </Text>
            <Text className="shrink-0 text-3xs font-t3-bold uppercase text-foreground-muted">
              {subagentStatusLabel(agent.status)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
function AgentRow({
  agent,
  onSelect,
}: {
  agent: DulliInspectorAgent;
  onSelect: (id: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.title}, ${subagentStatusLabel(agent.status)}`}
      onPress={() => onSelect(agent.id)}
      className="gap-1 rounded-xl border border-border bg-card px-3 py-2 active:bg-subtle-strong"
    >
      <View className="flex-row items-center gap-2">
        <StatusDot agent={agent} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-t3-bold">
          {agent.title}
        </Text>
        <Text className="text-xs text-foreground-muted">{subagentStatusLabel(agent.status)}</Text>
      </View>
      <Text numberOfLines={2} className="text-xs text-foreground-muted">
        {agentActivityText(agent) ?? subagentStatusLabel(agent.status)}
      </Text>
      <Text numberOfLines={1} className="text-3xs text-foreground-muted">
        {metadata(agent)}
      </Text>
    </Pressable>
  );
}
function WorkflowPhases({
  group,
  onSelect,
}: {
  group: DulliInspectorWorkflowGroup;
  onSelect: (id: string) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  return (
    <View className="gap-3" accessibilityLabel="Workflow phases">
      {group.phases.map((phase) => (
        <View key={phase.index} className="gap-2 border-l border-border pl-3">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !closed.has(phase.index) }}
            onPress={() =>
              setClosed((current) => {
                const next = new Set(current);
                if (next.has(phase.index)) next.delete(phase.index);
                else next.add(phase.index);
                return next;
              })
            }
            className="py-2"
          >
            <Text className="text-sm font-t3-bold">
              {closed.has(phase.index) ? "▸" : "▾"} {phase.title}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {phase.activeCount} working · {phase.settledCount}/{phase.members.length} settled
            </Text>
          </Pressable>
          {!closed.has(phase.index)
            ? phase.members.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onSelect={onSelect} />
              ))
            : null}
        </View>
      ))}
      {group.unphasedMembers.map((agent) => (
        <AgentRow key={agent.id} agent={agent} onSelect={onSelect} />
      ))}
    </View>
  );
}

export function DulliAgentsInspector({
  target,
  initialSubagentId,
}: {
  target: Target;
  initialSubagentId?: string | undefined;
}) {
  const inspector = useInspector(target);
  const [selectedId, setSelectedId] = useState(initialSubagentId ?? null);
  const selected = inspector?.presentation.agents.find((agent) => agent.id === selectedId);
  const parent = inspector?.presentation.workflows.find(
    (group) => group.workflow.id === selected?.parentAgentId,
  );
  const workflow = inspector?.presentation.workflows.find(
    (group) => group.workflow.id === selected?.id,
  );
  return (
    <View className="gap-3">
      {!selected ? (
        inspector?.presentation.batches.map((batch) => (
          <View key={batch.id} className="gap-2">
            <Text numberOfLines={2} className="text-xs text-foreground-muted">
              {batch.prompt}
            </Text>
            {batch.directAgents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onSelect={setSelectedId} />
            ))}
            {batch.workflows.map((group) => (
              <View key={group.workflow.id} className="gap-1">
                <Text className="text-3xs font-t3-bold uppercase text-foreground-muted">
                  Workflow
                </Text>
                <AgentRow agent={group.workflow} onSelect={setSelectedId} />
              </View>
            ))}
          </View>
        ))
      ) : inspector ? (
        <>
          <RequestActionButton
            label={parent ? "Back to workflow" : "Back to agents"}
            tone="secondary"
            onPress={() => setSelectedId(parent?.workflow.id ?? null)}
          />
          <AgentRunDetail
            key={selected.id}
            target={target}
            inspector={inspector}
            agent={selected}
          />
          {workflow ? (
            <WorkflowPhases key={workflow.workflow.id} group={workflow} onSelect={setSelectedId} />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
function AgentRunDetail({
  target,
  inspector,
  agent,
}: {
  target: Target;
  inspector: ReturnType<typeof deriveDulliAgentInspector>;
  agent: DulliInspectorAgent;
}) {
  const history = useEnvironmentQuery(
    orchestrationEnvironment.subagentTranscript({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        subagentId: agent.source.id,
        revision: inspector.revision(agent.id),
      },
    }),
  );
  const entries = useMemo(
    () =>
      dulliTranscriptEntries(
        inspector.transcript(agent.source, history.data?.items),
        agent.prompt,
        isActiveSubagentStatus(agent.status),
      ),
    [inspector, agent, history.data?.items],
  );
  const permission = useAtomValue(
    threadEnvironment.controlTask.permissionAtom(target.environmentId),
  );
  const control = useAtomCommand(threadEnvironment.controlTask, { reportFailure: false });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // This component is keyed by the durable run id so replies cannot leak to another agent.
  const act = async (action: "reply" | "stop") => {
    const taskId = agent.source.nativeTaskRef?.nativeId;
    if (
      !taskId ||
      pending ||
      !permission ||
      !inspector.canControl(agent.source) ||
      (action === "reply" && (agent.status !== "waiting" || !message.trim()))
    )
      return;
    setPending(true);
    setFeedback(null);
    const result = await control({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
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
  const resultAlreadyShown = entries.some(
    (entry) => entry.kind === "assistant" && entry.text.trim() === agent.result?.trim(),
  );
  return (
    <View className="gap-3">
      {agent.workflowName || agent.phaseTitle ? (
        <Text className="text-xs text-foreground-muted">
          {[agent.workflowName, agent.phaseTitle].filter(Boolean).join(" / ")}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        <StatusDot agent={agent} />
        <Text className="min-w-0 flex-1 text-base font-t3-bold">{agent.title}</Text>
        <Text className="text-xs text-foreground-muted">{subagentStatusLabel(agent.status)}</Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        {metadata(agent)} ·{" "}
        {formatSubagentDuration(agent.startedAt, agent.completedAt ?? agent.updatedAt)}
      </Text>
      {agentActivityText(agent) ? (
        <Text className="text-sm text-foreground-muted">{agentActivityText(agent)}</Text>
      ) : null}
      {agent.prompt ? (
        <TranscriptRow
          entry={{ id: "prompt", kind: "user", text: agent.prompt, live: false }}
          target={target}
        />
      ) : null}
      {history.isPending && !history.data ? (
        <Text className="text-xs text-foreground-muted">Loading transcript…</Text>
      ) : null}
      {history.error ? (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {history.error}
          </Text>
          <RequestActionButton
            label="Retry transcript"
            tone="secondary"
            onPress={history.refresh}
          />
        </View>
      ) : null}
      {entries.map((entry) => (
        <TranscriptRow key={entry.id} entry={entry} target={target} />
      ))}
      {agent.error ? (
        <View className="gap-2 rounded-xl border border-danger p-3">
          <Text className="text-xs font-t3-bold text-danger">Agent failed</Text>
          <Text selectable className="text-sm">
            {agent.error}
          </Text>
        </View>
      ) : agent.result && !resultAlreadyShown ? (
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <Text className="text-xs font-t3-bold">Final result</Text>
          <Text selectable className="text-sm">
            {agent.result}
          </Text>
        </View>
      ) : null}
      {!entries.length && !agent.result && !agent.error && !history.isPending ? (
        <Text className="py-5 text-center text-sm text-foreground-muted">
          Waiting for agent activity
        </Text>
      ) : null}
      {inspector.canControl(agent.source) ? (
        <View className="gap-2 border-t border-border pt-3">
          {agent.status === "waiting" ? (
            <TextInput
              accessibilityLabel="Reply to agent"
              placeholder="Answer what this agent is waiting for…"
              multiline
              maxLength={32000}
              value={message}
              onChangeText={setMessage}
              editable={permission && !pending}
              className="min-h-20 rounded-xl border border-border p-3 text-foreground"
            />
          ) : null}
          <View className="flex-row justify-end gap-2">
            <RequestActionButton
              label="Stop agent"
              tone="danger"
              disabled={!permission || pending}
              onPress={() => void act("stop")}
            />
            {agent.status === "waiting" ? (
              <RequestActionButton
                label="Reply"
                disabled={!permission || pending || !message.trim()}
                onPress={() => void act("reply")}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {feedback ? (
        <Text
          accessibilityRole={feedback.error ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          className={cn("text-xs", feedback.error ? "text-danger" : "text-foreground-muted")}
        >
          {feedback.text}
        </Text>
      ) : null}
    </View>
  );
}
function TranscriptRow({ entry, target }: { entry: DulliTranscriptEntry; target: Target }) {
  if (entry.kind === "tool") return <ToolRow entry={entry} target={target} />;
  return (
    <View
      className={cn(
        "gap-1 rounded-xl p-3",
        entry.kind === "user"
          ? "ml-5 bg-subtle-strong"
          : entry.kind === "reasoning"
            ? "bg-card"
            : "",
      )}
    >
      <Text className="text-3xs font-t3-bold uppercase text-foreground-muted">
        {entry.kind === "user"
          ? "You"
          : entry.kind === "reasoning"
            ? entry.live
              ? "Thinking"
              : "Reasoning"
            : entry.live
              ? "Assistant · working"
              : "Assistant"}
      </Text>
      <Text
        selectable
        className={cn(
          "text-sm",
          entry.kind === "reasoning" ? "text-foreground-muted" : "text-foreground",
        )}
      >
        {entry.text}
      </Text>
    </View>
  );
}
function ToolRow({
  entry,
  target,
}: {
  entry: Extract<DulliTranscriptEntry, { kind: "tool" }>;
  target: Target;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2 rounded-xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
      >
        <Text className="text-xs font-t3-bold">
          {open ? "▾" : "▸"} {entry.name} · {entry.live ? "Running" : entry.status}
        </Text>
      </Pressable>
      {entry.input ? (
        <Text
          numberOfLines={open ? undefined : 2}
          selectable
          className="text-xs text-foreground-muted"
        >
          {entry.input}
        </Text>
      ) : null}
      {open ? (
        <ToolOutput entry={entry} target={target} />
      ) : entry.output ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {entry.output}
        </Text>
      ) : null}
    </View>
  );
}
/** Native cards request bounded detail only when the user expands that card. */
function ToolOutput({
  entry,
  target,
}: {
  entry: Extract<DulliTranscriptEntry, { kind: "tool" }>;
  target: Target;
}) {
  const detail = useEnvironmentQuery(
    entry.source.outputOmitted
      ? orchestrationEnvironment.turnItem({
          environmentId: target.environmentId,
          input: {
            threadId: target.threadId,
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
  return (
    <View className="gap-2">
      {output ? (
        <Text selectable className="text-xs text-foreground-muted">
          {output}
        </Text>
      ) : null}
      {detail.isPending && !output ? (
        <Text className="text-xs text-foreground-muted">Loading tool output…</Text>
      ) : null}
      {detail.error ? (
        <>
          <Text accessibilityRole="alert" className="text-xs text-danger">
            {detail.error}
          </Text>
          <RequestActionButton label="Retry output" tone="secondary" onPress={detail.refresh} />
        </>
      ) : null}
    </View>
  );
}
