import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { memo, useCallback } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { subagentRunTitle, subagentStatusLabel, subagentStatusTone } from "./subagentPresentation";

const STATUS_DOT_CLASS = {
  info: "bg-blue-500",
  warning: "bg-amber-500",
  success: "bg-green-500",
  error: "bg-red-500",
  muted: "bg-foreground-muted",
} as const;

const SubagentRunRow = memo(function SubagentRunRow(props: {
  readonly agent: RuntimeSubagent;
  readonly onPress: (taskId: string) => void;
}) {
  const title = subagentRunTitle(props.agent);
  const status = subagentStatusLabel(props.agent.status);
  const tone = subagentStatusTone(props.agent.status);

  return (
    <Pressable
      accessibilityHint="Opens agent run details"
      accessibilityLabel={`Agent run: ${title}. Status: ${status}`}
      accessibilityRole="button"
      className="min-h-11 max-w-60 flex-row items-center gap-2 rounded-xl border border-border bg-card-translucent px-3 py-2 active:bg-subtle-strong"
      onPress={() => props.onPress(props.agent.id)}
    >
      <View
        accessibilityElementsHidden
        className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT_CLASS[tone])}
        importantForAccessibility="no"
      />
      <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
        {title}
      </Text>
      <Text className="shrink-0 text-3xs font-t3-bold uppercase text-foreground-muted">
        {status}
      </Text>
    </Pressable>
  );
});

export const SubagentRunRows = memo(function SubagentRunRows(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agents: ReadonlyArray<RuntimeSubagent>;
}) {
  const navigation = useNavigation();
  const openRun = useCallback(
    (taskId: string) => {
      void Haptics.selectionAsync();
      navigation.navigate("SubagentRun", {
        environmentId: String(props.environmentId),
        threadId: String(props.threadId),
        taskId,
      });
    },
    [navigation, props.environmentId, props.threadId],
  );

  if (props.agents.length === 0) return null;

  return (
    <View accessibilityLabel="Agent runs" className="shrink-0 pb-2">
      <ScrollView
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {props.agents.map((agent) => (
          <SubagentRunRow key={agent.id} agent={agent} onPress={openRun} />
        ))}
      </ScrollView>
    </View>
  );
});
