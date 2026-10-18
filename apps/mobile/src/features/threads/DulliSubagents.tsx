import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  deriveDulliAgentInspector,
  dulliTranscriptText,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { RequestActionButton } from "./RequestActionButton";

type Target = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
function useInspector(target: Target) {
  const thread = useAtomValue(environmentThreadDetails.threadAtom(target));
  return useMemo(() => (thread ? deriveDulliAgentInspector(thread.projection) : null), [thread]);
}

/** Compact persisted child rows above the composer, on both iOS and Android. */
export function DulliSubagentRows({ target }: { target: Target }) {
  const inspector = useInspector(target);
  const navigation = useNavigation();
  if (!inspector?.agents.length) return null;
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-card p-2">
      {inspector.agents.slice(0, 4).map((agent) => (
        <Pressable
          key={agent.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${agent.title ?? "agent"}, ${agent.status}`}
          onPress={() => navigation.navigate("ThreadAgents", { ...target, subagentId: agent.id })}
          className="flex-row items-center gap-2 px-2 py-1"
        >
          <Text numberOfLines={1} className="flex-1 text-sm text-foreground">
            {agent.title || agent.prompt || "Agent"}
          </Text>
          <Text className="text-xs text-foreground-muted">{agent.status}</Text>
        </Pressable>
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
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = inspector?.agents.find((agent) => agent.id === selectedId);
  const transcript = useEnvironmentQuery(
    selected
      ? orchestrationEnvironment.subagentTranscript({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, subagentId: selected.id },
        })
      : null,
  );
  const permission = useAtomValue(
    threadEnvironment.controlTask.permissionAtom(target.environmentId),
  );
  const control = useAtomCommand(threadEnvironment.controlTask);
  const act = async (action: "steer" | "reply" | "stop") => {
    if (!selected?.nativeTaskRef?.nativeId || pending) return;
    setPending(true);
    setError(null);
    const result = await control({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        taskId: selected.nativeTaskRef.nativeId,
        ...(action === "stop" ? { action } : { action, message: message.trim() }),
      },
    });
    setPending(false);
    if (AsyncResult.isSuccess(result)) setMessage("");
    else
      setError("Child control failed. The child may have ended or its extension is unavailable.");
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-3 px-4 pb-10"
    >
      {!selected ? (
        inspector?.groups.map((group) => (
          <View key={group.id} className="gap-2">
            <Text numberOfLines={2} className="text-xs text-foreground-muted">
              {group.prompt}
            </Text>
            {group.agents.map((agent) => (
              <Pressable
                key={agent.id}
                accessibilityRole="button"
                onPress={() => {
                  setSelectedId(agent.id);
                  setMessage("");
                  setError(null);
                }}
                className="rounded-xl border border-border p-3"
              >
                <Text className="text-sm font-bold text-foreground">
                  {agent.title || agent.prompt || "Agent"}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {agent.status} · {agent.model ?? "Provider default"}
                </Text>
              </Pressable>
            ))}
          </View>
        ))
      ) : (
        <>
          <RequestActionButton
            label="Back to agents"
            tone="secondary"
            onPress={() => setSelectedId(null)}
          />
          <Text className="text-lg font-bold text-foreground">{selected.title ?? "Agent"}</Text>
          <Text className="text-xs text-foreground-muted">
            {selected.status} · {selected.model ?? "Provider default"}
            {selected.modelSelection?.options?.find((option) => option.id === "reasoning")?.value
              ? ` · ${selected.modelSelection.options.find((option) => option.id === "reasoning")!.value}`
              : ""}
            {selected.usage
              ? ` · ${selected.usage.totalTokens.toLocaleString()} tokens · ${selected.usage.toolUses ?? 0} tools`
              : ""}
          </Text>
          <Text className="text-sm font-bold text-foreground">Original prompt</Text>
          <Text selectable className="text-sm text-foreground">
            {selected.prompt}
          </Text>
          {inspector?.children(selected).map((child) => (
            <Pressable
              key={child.id}
              accessibilityRole="button"
              onPress={() => {
                setSelectedId(child.id);
                setMessage("");
                setError(null);
              }}
              className="rounded-lg border border-border p-2"
            >
              <Text className="text-sm text-foreground">{child.title ?? child.prompt}</Text>
              <Text className="text-xs text-foreground-muted">
                {
                  selected.workflow?.agents.find(
                    (agent) => agent.agentId === child.nativeTaskRef?.nativeId,
                  )?.phaseTitle
                }{" "}
                · {child.status}
              </Text>
            </Pressable>
          ))}
          {selected.progress ? (
            <Text className="text-sm text-foreground-muted">{selected.progress}</Text>
          ) : null}
          {transcript.isPending && !transcript.data ? (
            <Text className="text-sm text-foreground-muted">Loading transcript…</Text>
          ) : null}
          {transcript.error ? (
            <View>
              <Text accessibilityRole="alert" className="text-sm text-danger">
                {transcript.error}
              </Text>
              <RequestActionButton
                label="Retry transcript"
                tone="secondary"
                onPress={transcript.refresh}
              />
            </View>
          ) : null}
          {inspector?.transcript(selected, transcript.data?.items).map((item) => (
            <View key={item.id} className="gap-1">
              <Text className="text-xs font-bold text-foreground-muted">
                {item.type === "reasoning"
                  ? "Thinking"
                  : item.type === "dynamic_tool"
                    ? `${item.toolName ?? "Tool"} · ${item.status}`
                    : item.type === "user_message"
                      ? "User"
                      : "Assistant"}
              </Text>
              <ChildTranscriptText item={item} environmentId={target.environmentId} />
            </View>
          ))}
          {selected.result ? (
            <View>
              <Text className="text-sm font-bold text-foreground">
                {selected.status === "failed" ? "Error" : "Result"}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {selected.result}
              </Text>
            </View>
          ) : null}
          {inspector?.canControl(selected) ? (
            <View className="gap-2">
              <TextInput
                accessibilityLabel={
                  selected.status === "waiting" ? "Reply to agent" : "Steer agent"
                }
                placeholder={selected.status === "waiting" ? "Reply to agent" : "Steer agent"}
                multiline
                maxLength={32000}
                value={message}
                onChangeText={setMessage}
                editable={permission && !pending}
                className="min-h-20 rounded-xl border border-border p-3 text-foreground"
              />
              <View className="flex-row gap-2">
                <RequestActionButton
                  label={selected.status === "waiting" ? "Reply" : "Steer"}
                  disabled={!permission || pending || !message.trim()}
                  onPress={() => void act(selected.status === "waiting" ? "reply" : "steer")}
                />
                <RequestActionButton
                  label="Stop agent"
                  tone="danger"
                  disabled={!permission || pending}
                  onPress={() => void act("stop")}
                />
              </View>
            </View>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {error}
            </Text>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function ChildTranscriptText({
  item,
  environmentId,
}: {
  item: OrchestrationV2TurnItem;
  environmentId: EnvironmentId;
}) {
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
    <Text selectable className="text-sm text-foreground">
      {dulliTranscriptText(detail.data?.item ?? item)}
    </Text>
  );
}
