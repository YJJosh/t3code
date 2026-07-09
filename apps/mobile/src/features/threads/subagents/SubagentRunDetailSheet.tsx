import { selectSubagentRun, type SubagentRunEntry } from "@t3tools/client-runtime/state/subagents";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { ActivityIndicator, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useRemoteEnvironmentRuntime } from "../../../state/use-remote-environment-registry";
import { useSubagentRuntime } from "../../../state/use-subagent-runtime";
import { useThreadSelection } from "../../../state/use-thread-selection";
import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
  selectVisibleSubagentActivity,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
  summarizeSubagentActivity,
  threadSupportsPiSubagents,
} from "./subagentPresentation";

const STATUS_PILL_CLASS = {
  info: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  success: "bg-green-500/15 text-green-700 dark:text-green-300",
  error: "bg-red-500/15 text-red-700 dark:text-red-300",
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
      <Text selectable className="text-sm font-t3-medium" numberOfLines={2}>
        {props.value}
      </Text>
    </View>
  );
}

function RunDetail(props: { readonly run: SubagentRunEntry }) {
  const { view } = props.run;
  const status = subagentStatusLabel(view.state);
  const statusClass = STATUS_PILL_CLASS[subagentStatusTone(view.state)];
  const activity = selectVisibleSubagentActivity(props.run);
  const openQuestions = Array.from(
    new Set([...view.openQuestions, ...(view.result?.result?.open_questions ?? [])]),
  );
  const progressNote = view.progressNote?.trim();
  const resultSummary = view.result?.result?.summary.trim();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 24, paddingHorizontal: 16, paddingVertical: 20 }}
      className="flex-1 bg-sheet"
    >
      <View className="gap-3 rounded-[20px] border border-border bg-card p-4">
        <View className="flex-row items-center gap-2">
          <View
            accessibilityLabel={`Status: ${status}`}
            className={`rounded-full px-2.5 py-1 ${statusClass}`}
          >
            <Text className={`text-2xs font-t3-bold uppercase ${statusClass}`}>{status}</Text>
          </View>
          <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
            Child run
          </Text>
        </View>
        <Text selectable className="text-base leading-relaxed">
          {view.task.trim() || view.runId}
        </Text>
      </View>

      <Section title="Details">
        <View className="flex-row flex-wrap gap-2">
          <Fact label="Model" value={view.model || "Unknown"} />
          <Fact label="Status" value={status} />
          <Fact label="Turns" value={String(view.turns)} />
          <Fact label="Active" value={formatSubagentActiveMs(view.activeMs)} />
        </View>
        {view.directory ? <Fact label="Directory" value={view.directory} /> : null}
        {view.skills.length > 0 ? <Fact label="Skills" value={view.skills.join(", ")} /> : null}
      </Section>

      {progressNote || view.managerRequest ? (
        <Section title="Progress">
          {progressNote ? (
            <Text
              selectable
              className="rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed"
            >
              {progressNote}
            </Text>
          ) : null}
          {view.managerRequest ? (
            <View className="gap-1 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
              <Text className="text-xs font-t3-bold text-amber-700 dark:text-amber-300">
                Input requested
              </Text>
              <Text selectable className="text-sm leading-relaxed text-foreground-secondary">
                {view.managerRequest.message}
              </Text>
            </View>
          ) : null}
        </Section>
      ) : null}

      {view.result ? (
        <Section title="Result">
          <View className="gap-2 rounded-2xl border border-border bg-card px-4 py-3">
            <Text className="text-xs font-t3-bold uppercase text-foreground-secondary">
              {view.result.status}
            </Text>
            {resultSummary ? (
              <Text selectable className="text-sm leading-relaxed">
                {resultSummary}
              </Text>
            ) : null}
            {view.result.reason ? (
              <Text selectable className="text-sm leading-relaxed text-foreground-secondary">
                {view.result.reason}
              </Text>
            ) : null}
            {view.result.result && view.result.result.files_changed.length > 0 ? (
              <Text selectable className="text-xs leading-relaxed text-foreground-muted">
                Files changed: {view.result.result.files_changed.join(", ")}
              </Text>
            ) : null}
          </View>
        </Section>
      ) : null}

      {openQuestions.length > 0 ? (
        <Section title="Open questions">
          <View className="gap-2 rounded-2xl border border-border bg-card px-4 py-3">
            {openQuestions.map((question) => (
              <View key={question} className="flex-row gap-2">
                <Text className="text-foreground-muted">•</Text>
                <Text selectable className="min-w-0 flex-1 text-sm leading-relaxed">
                  {question}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      <Section title="Usage">
        <View className="flex-row flex-wrap gap-2">
          <Fact label="Total" value={formatSubagentTokens(view.usageSoFar)} />
          <Fact label="Estimated cost" value={formatSubagentCost(view.usageSoFar)} />
          <Fact label="Input" value={view.usageSoFar.input.toLocaleString()} />
          <Fact label="Output" value={view.usageSoFar.output.toLocaleString()} />
          <Fact label="Cache read" value={view.usageSoFar.cacheRead.toLocaleString()} />
          <Fact label="Cache write" value={view.usageSoFar.cacheWrite.toLocaleString()} />
        </View>
      </Section>

      <Section title={`Activity · latest ${activity.length}`}>
        {activity.length === 0 ? (
          <Text className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground-muted">
            No child activity yet.
          </Text>
        ) : (
          <View className="overflow-hidden rounded-2xl border border-border bg-card">
            {activity.map((entry, index) => (
              <View
                key={`${entry.sequence}:${entry.type}`}
                className={
                  index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border px-4 py-3"
                }
              >
                <Text className="text-3xs font-t3-bold uppercase tracking-[0.6px] text-foreground-muted">
                  {entry.type}
                </Text>
                <Text selectable className="text-xs leading-relaxed text-foreground-secondary">
                  {summarizeSubagentActivity(entry)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}

type SubagentRunDetailSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly runId: string;
}>;

export function SubagentRunDetailSheet(props: SubagentRunDetailSheetProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread } = useThreadSelection();
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const isActiveThread =
    selectedThread?.environmentId === environmentId && selectedThread.id === threadId;
  const enabled =
    isActiveThread &&
    selectedThread !== null &&
    threadSupportsPiSubagents(selectedThread, environmentRuntime?.serverConfig ?? null);
  const query = useSubagentRuntime({ environmentId, threadId, enabled });
  const run = selectSubagentRun(query.state, props.route.params.runId);
  const title = run ? subagentRunTitle(run.view.task, run.view.runId) : "Child run";

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title }} />
      {run ? (
        <RunDetail run={run} />
      ) : enabled && query.isPending ? (
        <View
          accessibilityLabel="Loading child run"
          className="flex-1 items-center justify-center gap-3 px-6"
        >
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Loading child run…</Text>
        </View>
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Text accessibilityRole="header" className="text-lg font-t3-bold">
            Child run unavailable
          </Text>
          <Text className="mt-2 text-center text-sm text-foreground-muted">
            This read-only run is no longer available for the active thread.
          </Text>
        </View>
      )}
    </View>
  );
}
