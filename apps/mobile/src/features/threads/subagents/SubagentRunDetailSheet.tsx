import {
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId, type ProviderTaskControlInput } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../../state/use-thread-detail";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { cn } from "../../../lib/cn";
import {
  formatSubagentDuration,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
} from "./subagentPresentation";

const STATUS_PILL_CLASS = {
  info: "bg-adaptive-blue-50-blue-400-a14 text-adaptive-blue-600-400",
  warning: "bg-adaptive-amber-500-a12-a16 text-adaptive-amber-700-300",
  success: "bg-adaptive-emerald-500-a12-a16 text-adaptive-emerald-700-300",
  error: "bg-danger text-danger-foreground",
  muted: "bg-foreground-muted/15 text-foreground-muted",
} as const;

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text
        accessibilityRole="header"
        className="text-xs font-t3-bold uppercase tracking-[0.9px] text-foreground-muted"
      >
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function Fact(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="min-w-[46%] flex-1 rounded-2xl border border-border bg-card px-3.5 py-3">
      <Text className="text-3xs font-t3-bold uppercase tracking-[0.7px] text-foreground-muted">
        {props.label}
      </Text>
      <Text selectable className="text-sm font-t3-medium">
        {props.value}
      </Text>
    </View>
  );
}

function RunDetail(props: {
  readonly agent: RuntimeSubagent;
  readonly controlsEnabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { agent } = props;
  const controlTask = useAtomCommand(threadEnvironment.controlTask, { reportFailure: false });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<ProviderTaskControlInput["action"] | null>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);

  useEffect(() => {
    setMessage("");
    setPending(null);
    setControlStatus(null);
  }, [agent.id]);

  const status = subagentStatusLabel(agent.status);
  const statusClass = STATUS_PILL_CLASS[subagentStatusTone(agent.status)];
  const messageAction = agent.status === "waiting" ? "reply" : "steer";
  const canControl =
    props.controlsEnabled &&
    agent.kind !== "workflow" &&
    !isTerminalSubagentStatus(agent.status) &&
    agent.status !== "idle";

  const submitControl = async (action: ProviderTaskControlInput["action"]) => {
    const trimmedMessage = message.trim();
    if (action !== "stop" && trimmedMessage.length === 0) return;
    const input: ProviderTaskControlInput =
      action === "stop"
        ? { threadId: props.threadId, taskId: agent.id, action }
        : { threadId: props.threadId, taskId: agent.id, action, message: trimmedMessage };
    setPending(action);
    setControlStatus(null);
    const result = await controlTask({ environmentId: props.environmentId, input });
    setPending(null);
    if (result._tag === "Failure") {
      setControlStatus("The task control could not be delivered.");
      return;
    }
    setMessage("");
    setControlStatus(
      action === "stop"
        ? "Stop requested."
        : action === "reply"
          ? "Reply requested."
          : "Guidance requested.",
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 24, paddingHorizontal: 16, paddingVertical: 20 }}
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-3 rounded-[20px] border border-border bg-card p-4">
        <View className="flex-row items-center gap-2">
          <View
            accessibilityLabel={`Status: ${status}`}
            className={cn("rounded-full px-2.5 py-1", statusClass)}
          >
            <Text className={cn("text-2xs font-t3-bold uppercase", statusClass)}>{status}</Text>
          </View>
          <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
            Agent run
          </Text>
        </View>
        <Text selectable className="text-base leading-relaxed">
          {subagentRunTitle(agent)}
        </Text>
      </View>

      <Section title="Details">
        <View className="flex-row flex-wrap gap-2">
          <Fact
            label="Model"
            value={formatSubagentModelLabel(agent.model, agent.effort) ?? "Unknown"}
          />
          <Fact label="Status" value={status} />
          <Fact label="Task ID" value={agent.id} />
          <Fact label="Active" value={formatSubagentDuration(agent.startedAt, agent.completedAt)} />
          {agent.role ? <Fact label="Role" value={agent.role} /> : null}
          {agent.phaseTitle ? <Fact label="Phase" value={agent.phaseTitle} /> : null}
        </View>
      </Section>

      {agent.progress || agent.error || agent.result ? (
        <Section title={agent.error ? "Error" : agent.result ? "Result" : "Progress"}>
          <Text
            selectable
            className={cn(
              "rounded-2xl border bg-card px-4 py-3 text-sm leading-relaxed",
              agent.error ? "border-danger-border text-danger-foreground" : "border-border",
            )}
          >
            {agent.error ?? agent.result ?? agent.progress}
          </Text>
        </Section>
      ) : null}

      {agent.usage ? (
        <Section title="Usage">
          <View className="flex-row flex-wrap gap-2">
            <Fact
              label="Total"
              value={`${formatSubagentTokenCount(agent.usage.totalTokens)} tokens`}
            />
            {agent.usage.inputTokens !== undefined ? (
              <Fact label="Input" value={agent.usage.inputTokens.toLocaleString()} />
            ) : null}
            {agent.usage.outputTokens !== undefined ? (
              <Fact label="Output" value={agent.usage.outputTokens.toLocaleString()} />
            ) : null}
            {agent.usage.toolUses !== undefined ? (
              <Fact label="Tools" value={agent.usage.toolUses.toLocaleString()} />
            ) : null}
          </View>
        </Section>
      ) : null}

      {agent.recentActivity.length > 0 ? (
        <Section title={`Activity · latest ${agent.recentActivity.length}`}>
          <View className="overflow-hidden rounded-2xl border border-border bg-card">
            {agent.recentActivity.map((entry, index) => (
              <View
                key={`${entry.at}:${entry.summary}`}
                className={
                  index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border px-4 py-3"
                }
              >
                <Text className="text-3xs font-t3-bold uppercase tracking-[0.6px] text-foreground-muted">
                  {entry.at}
                </Text>
                <Text selectable className="text-xs leading-relaxed text-foreground-secondary">
                  {entry.summary}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {canControl ? (
        <Section title={messageAction === "reply" ? "Answer requested input" : "Agent controls"}>
          <TextInput
            accessibilityLabel={messageAction === "reply" ? "Reply to agent" : "Steer agent"}
            className="min-h-24 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground"
            editable={pending === null}
            multiline
            onChangeText={setMessage}
            placeholder={messageAction === "reply" ? "Send the answer…" : "Send guidance…"}
            placeholderTextColor="#888888"
            textAlignVertical="top"
            value={message}
          />
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              className="min-h-11 items-center justify-center rounded-xl bg-foreground px-4 active:opacity-75 disabled:opacity-40"
              disabled={pending !== null || message.trim().length === 0}
              onPress={() => void submitControl(messageAction)}
            >
              <Text className="font-t3-bold text-background">
                {messageAction === "reply" ? "Reply" : "Steer"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 items-center justify-center rounded-xl bg-red-600 px-4 active:opacity-75 disabled:opacity-40"
              disabled={pending !== null}
              onPress={() => void submitControl("stop")}
            >
              <Text className="font-t3-bold text-white">Stop agent</Text>
            </Pressable>
          </View>
          {controlStatus ? (
            <Text className="text-xs text-foreground-muted">{controlStatus}</Text>
          ) : null}
        </Section>
      ) : null}
    </ScrollView>
  );
}

type SubagentRunDetailSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly taskId: string;
}>;

export function SubagentRunDetailSheet(props: SubagentRunDetailSheetProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread } = useThreadSelection();
  const detail = useSelectedThreadDetail();
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const agent = useMemo(
    () =>
      detail?.id === threadId
        ? (foldSubagentActivities(detail.activities).find(
            (entry) => entry.id === props.route.params.taskId,
          ) ?? null)
        : null,
    [detail, props.route.params.taskId, threadId],
  );
  const providerInstanceId =
    selectedThread?.session?.providerInstanceId ?? selectedThread?.modelSelection.instanceId;
  const provider = environmentRuntime?.serverConfig?.providers.find(
    (entry) => entry.instanceId === providerInstanceId,
  );
  const controlsEnabled =
    provider?.driver === "pi" || selectedThread?.session?.providerName === "pi";
  const title = agent ? subagentRunTitle(agent) : "Agent run";

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title }} />
      {agent ? (
        <RunDetail
          agent={agent}
          controlsEnabled={controlsEnabled}
          environmentId={environmentId}
          threadId={threadId}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Text accessibilityRole="header" className="text-lg font-t3-bold">
            Agent run unavailable
          </Text>
          <Text className="mt-2 text-center text-sm text-foreground-muted">
            This run is no longer available for the active thread.
          </Text>
        </View>
      )}
    </View>
  );
}
