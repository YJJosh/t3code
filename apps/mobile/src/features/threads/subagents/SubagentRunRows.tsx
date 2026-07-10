import {
  isSubagentRunActive,
  type SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
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
} as const;

const SubagentRunRow = memo(function SubagentRunRow(props: {
  readonly run: SubagentRunEntry;
  readonly onPress: (runId: string) => void;
}) {
  const title = subagentRunTitle(props.run.view.task, props.run.view.runId);
  const status = subagentStatusLabel(props.run.view.state);
  const tone = subagentStatusTone(props.run.view.state);
  const active = isSubagentRunActive(props.run.view.state);

  return (
    <Pressable
      accessibilityHint="Opens read-only child run details"
      accessibilityLabel={`Child run: ${title}. Status: ${status}`}
      accessibilityRole="button"
      className="min-h-11 max-w-60 flex-row items-center gap-2 rounded-xl border border-border bg-card-translucent px-3 py-2 active:bg-subtle-strong"
      onPress={() => props.onPress(props.run.view.runId)}
    >
      <View
        accessibilityElementsHidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          STATUS_DOT_CLASS[tone],
          active && "opacity-80",
        )}
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
  readonly runs: ReadonlyArray<SubagentRunEntry>;
}) {
  const navigation = useNavigation();
  const openRun = useCallback(
    (runId: string) => {
      void Haptics.selectionAsync();
      navigation.navigate("SubagentRun", {
        environmentId: String(props.environmentId),
        threadId: String(props.threadId),
        runId,
      });
    },
    [navigation, props.environmentId, props.threadId],
  );

  if (props.runs.length === 0) return null;

  return (
    <View accessibilityLabel="Child runs" className="shrink-0 pb-2">
      <ScrollView
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {props.runs.map((run) => (
          <SubagentRunRow key={run.view.runId} run={run} onPress={openRun} />
        ))}
      </ScrollView>
    </View>
  );
});
