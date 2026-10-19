import {
  MessageId,
  NodeId,
  TurnItemId,
  ProviderDriverKind,
  ProviderTaskControlError,
  type ProviderTaskControlInput,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { DulliBridgeContext, DulliBridgeFactory } from "@t3tools/provider-dulli/server";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { DulliSubagents } from "./DulliSubagents.ts";

const DRIVER = ProviderDriverKind.make("dulli");
export const SUBAGENT_PREFIX = "pi-subagents:event:v1:";
const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ControlResult = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  action: Schema.Literals(["status", "replay", "steer", "reply", "kill"]),
  success: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
const BridgeEvent = Schema.Struct({
  contractVersion: Schema.Literal(1),
  managerId: Schema.NonEmptyString,
  sequence: Schema.Int,
  timestamp: Schema.String,
  kind: Schema.String,
  runId: Schema.optional(Schema.String),
  view: Schema.optional(RecordSchema),
  activity: Schema.optional(RecordSchema),
  control: Schema.optional(ControlResult),
  snapshot: Schema.optional(RecordSchema),
  replay: Schema.optional(Schema.Boolean),
});
type BridgeEvent = typeof BridgeEvent.Type;
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(BridgeEvent));
const decodeEventRecord = Schema.decodeUnknownOption(BridgeEvent);
const isControlError = Schema.is(ProviderTaskControlError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
const lifecycle = new Set([
  "run_created",
  "run_running",
  "resumed",
  "steered",
  "needs_input",
  "terminal",
  "killed",
  "interrupted",
]);
const nodeId = (context: DulliBridgeContext, runId: string) =>
  NodeId.make(
    `dulli:subagent:${encodeURIComponent(context.threadId)}:${encodeURIComponent(runId)}`,
  );
const itemId = (id: NodeId) => TurnItemId.make(`${id}:task`);
const stateOf = (
  view: Record<string, unknown>,
  kind: string,
): OrchestrationV2Subagent["status"] => {
  if (kind === "killed" || view.state === "killed") return "cancelled";
  if (kind === "interrupted" || view.state === "interrupted") return "interrupted";
  if (view.state === "done") return "completed";
  if (view.state === "failed") return "failed";
  if (kind === "terminal") return "cancelled";
  if (kind === "needs_input" || view.state === "needs_input") return "waiting";
  if (kind === "run_created" || view.state === "queued") return "pending";
  return "running";
};
const usageOf = (view: Record<string, unknown>): OrchestrationV2Subagent["usage"] => {
  const raw = record(view.usageSoFar);
  const totalTokens = number(raw.total);
  return totalTokens === undefined
    ? undefined
    : {
        totalTokens,
        ...(number(raw.input) === undefined ? {} : { inputTokens: number(raw.input)! }),
        ...(number(raw.cacheRead) === undefined
          ? {}
          : { cachedInputTokens: number(raw.cacheRead)! }),
        ...(number(raw.output) === undefined ? {} : { outputTokens: number(raw.output)! }),
        ...(number(raw.turns) === undefined ? {} : { toolUses: number(raw.turns)! }),
        ...(number(view.activeMs) === undefined ? {} : { durationMs: number(view.activeMs)! }),
      };
};

// Stable ring slots bound the persisted projection as well as process memory.
// Oldest retained content is cleared when the aggregate exceeds 2 MiB/run.
// Native event identities are retained in nativeItemRef, allowing replay to skip
// already-seen slots and preventing older replay from replacing newer content.
const TRANSCRIPT_SLOTS = 1000;
const TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const text = (value: unknown, limit = TRANSCRIPT_BYTES): string => {
  const source = typeof value === "string" ? value : encodeJson(value ?? "");
  // Strip terminal control sequences before any client renders tool output.
  const clean = source
    // eslint-disable-next-line no-control-regex -- Strip native terminal escape/control sequences before persistence.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex -- Strip native terminal escape/control sequences before persistence.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- Strip native terminal escape/control sequences before persistence.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const bytes = Buffer.from(clean);
  return bytes.length <= limit
    ? clean
    : `${bytes.subarray(0, limit - 20).toString("utf8")}\n[truncated]`;
};
const toolOutput = (value: unknown) => {
  const content = Array.isArray(value) ? value : record(value).content;
  return Array.isArray(content)
    ? content
        .map((part) =>
          record(part).type === "image" ? "[image]" : (string(record(part).text) ?? ""),
        )
        .join("\n")
    : value;
};
const assistantParts = (message: unknown) => {
  const content = record(message).content;
  if (typeof content === "string") return { text: content, thinking: "" };
  const parts = Array.isArray(content) ? content.map(record) : [];
  return {
    text: parts
      .filter((part) => part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join(""),
    thinking: parts
      .filter((part) => part.type === "thinking")
      .map((part) =>
        part.redacted === true
          ? "[redacted reasoning]"
          : typeof part.thinking === "string"
            ? part.thinking
            : typeof part.text === "string"
              ? part.text
              : "",
      )
      .join(""),
  };
};

export const makeSubagentFactory =
  (dependencies: {
    readonly controls: DulliSubagents["Service"];
    readonly read: (threadId: DulliBridgeContext["threadId"]) => Effect.Effect<{
      readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
      readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    }>;
  }): DulliBridgeFactory =>
  (context) =>
    Effect.gen(function* () {
      const stored = yield* dependencies.read(context.threadId);
      let fallbackRootPublished = false;
      const agents = new Map(
        stored.subagents
          .filter((agent) => agent.driver === DRIVER)
          .map((agent) => [agent.nativeTaskRef?.nativeId ?? "", agent]),
      );
      const items = new Map(
        stored.turnItems
          .filter((item) => item.id.startsWith("dulli:subagent:"))
          .map((item) => [item.id, item]),
      );
      const live = new Map<string, { text: string; thinking: string; sequence: number }>();
      const publishedAt = new Map<string, number>();
      const waiters = new Map<
        string,
        Deferred.Deferred<typeof ControlResult.Type, ProviderTaskControlError>
      >();
      let stopped = false;
      let token: symbol | undefined;
      const fail = (detail: string, taskId = "subagent-control") =>
        new ProviderTaskControlError({ threadId: context.threadId, taskId, detail });

      const advertised = Effect.gen(function* () {
        const reply = yield* context.rpc.request({ type: "get_commands" });
        const commands = record(reply).commands;
        return (
          Array.isArray(commands) &&
          commands.some((entry) => record(entry).name === "subagents-rpc")
        );
      });
      const control = (input: ProviderTaskControlInput, requestedAt?: DateTime.Utc) =>
        Effect.gen(function* () {
          if (stopped) return yield* fail("Dulli session ended.");
          // Unknown Pi slash commands are model prompts, not harmless no-ops.
          if (!(yield* advertised))
            return yield* fail(
              "The Pi subagent control extension is not installed in this session.",
            );
          if (stopped) return yield* fail("Dulli session ended.");
          const current = agents.get(input.taskId);
          // Discovery itself awaits RPC: a child can resume while it is in flight.
          if (
            requestedAt &&
            current?.startedAt &&
            DateTime.toEpochMillis(current.startedAt) > DateTime.toEpochMillis(requestedAt)
          )
            return;
          const action = input.action === "stop" ? "kill" : input.action;
          const requestId = `t3-${yield* randomUuidV4}`;
          const waiter = yield* Deferred.make<
            typeof ControlResult.Type,
            ProviderTaskControlError
          >();
          waiters.set(requestId, waiter);
          const result = yield* Effect.gen(function* () {
            yield* context.rpc.request({
              type: "prompt",
              message: `/subagents-rpc ${encodeJson({
                action,
                request_id: requestId,
                run_id: input.taskId,
                ...(input.action === "stop"
                  ? { reason: input.reason ?? "Stopped from T3 Code" }
                  : { message: input.message }),
              })}`,
            });
            return yield* Deferred.await(waiter).pipe(Effect.timeout("12 seconds"));
          }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(requestId))));
          if (!result.success || result.action !== action)
            return yield* fail(result.error ?? `Pi rejected the ${input.action} task control.`);
        }).pipe(Effect.mapError((error) => (isControlError(error) ? error : fail(String(error)))));

      const publishAgent = (agent: OrchestrationV2Subagent) =>
        Effect.gen(function* () {
          const active = context.getActiveTurn();
          const run = active?.input.runId === agent.runId ? active : null;
          const previousTask = items.get(itemId(agent.id));
          const providerTurnId = previousTask?.providerTurnId ?? run?.providerTurn.id ?? null;
          let rootNodeId = agent.parentNodeId;
          const seen = new Set<NodeId>([agent.id]);
          while (!seen.has(rootNodeId)) {
            seen.add(rootNodeId);
            const parent = [...agents.values()].find((candidate) => candidate.id === rootNodeId);
            if (!parent) break;
            rootNodeId = parent.parentNodeId;
          }
          agents.set(agent.nativeTaskRef!.nativeId!, agent);
          yield* context.emit({
            type: "node.updated",
            driver: DRIVER,
            node: {
              id: agent.id,
              threadId: agent.threadId,
              runId: agent.runId,
              parentNodeId: agent.parentNodeId,
              rootNodeId,
              kind: "subagent",
              status: agent.status,
              countsForRun: false,
              providerThreadId: agent.providerThreadId,
              providerTurnId,
              nativeItemRef: agent.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: agent.startedAt,
              completedAt: agent.completedAt,
            },
          });
          yield* context.emit({ type: "subagent.updated", driver: DRIVER, subagent: agent });
          const taskItem: OrchestrationV2TurnItem = {
            id: itemId(agent.id),
            threadId: agent.threadId,
            runId: agent.runId,
            nodeId: agent.id,
            providerThreadId: agent.providerThreadId,
            providerTurnId,
            nativeItemRef: agent.nativeTaskRef,
            parentItemId: null,
            ordinal: previousTask?.ordinal ?? context.getItemOrdinal?.(agent.id) ?? 0,
            status: agent.status,
            title: agent.title,
            startedAt: agent.startedAt,
            completedAt: agent.completedAt,
            updatedAt: agent.updatedAt,
            type: "subagent",
            subagentId: agent.id,
            origin: "provider_native",
            driver: DRIVER,
            providerInstanceId: agent.providerInstanceId,
            childThreadId: null,
            prompt: agent.prompt,
            result: agent.result,
            ...(agent.progress === undefined ? {} : { progress: agent.progress }),
          };
          items.set(taskItem.id, taskItem);
          yield* context.emit({ type: "turn_item.updated", driver: DRIVER, turnItem: taskItem });
          if (terminal(agent.status)) {
            for (const [id, item] of items) {
              if (
                item.nodeId !== agent.id ||
                !["pending", "running", "waiting"].includes(item.status)
              )
                continue;
              const ended = {
                ...item,
                status: agent.status,
                completedAt: agent.completedAt,
                updatedAt: agent.updatedAt,
                ...(item.type === "assistant_message" || item.type === "reasoning"
                  ? { streaming: false }
                  : {}),
              };
              items.set(id, ended);
              yield* context.emit({ type: "turn_item.updated", driver: DRIVER, turnItem: ended });
            }
          }
        });

      const projectView = (
        event: BridgeEvent,
        view: Record<string, unknown>,
        forceCurrent = false,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const runId = string(view.runId) ?? event.runId;
          if (!runId) return;
          const old = agents.get(runId);
          const now = DateTime.makeUnsafe(
            Number.isFinite(Date.parse(event.timestamp))
              ? event.timestamp
              : yield* Clock.currentTimeMillis,
          );
          // Snapshots carry current states only. A delayed historical lifecycle must
          // never revive an ended child (resumed/steered live events may do so).
          if (
            old &&
            !forceCurrent &&
            event.replay &&
            DateTime.toEpochMillis(now) <= DateTime.toEpochMillis(old.updatedAt)
          )
            return;
          const turn = context.getActiveTurn();
          const parent = old
            ? [...agents.values()].find((candidate) => candidate.id === old.parentNodeId)
            : undefined;
          const previousMember = parent?.workflow?.agents.find(
            (member) => member.agentId === runId,
          );
          const workflow =
            view.workflow === undefined && parent?.nativeTaskRef?.nativeId
              ? {
                  runId: parent.nativeTaskRef.nativeId,
                  name: parent.workflow?.name,
                  phase: previousMember?.phaseTitle,
                  label: old?.title,
                }
              : record(view.workflow);
          const parentRun = string(workflow.runId);
          if (parentRun && parentRun !== runId && !agents.has(parentRun)) {
            yield* projectView(
              { ...event, runId: parentRun, kind: "run_created" },
              {
                runId: parentRun,
                task: string(workflow.name) ?? "Workflow",
                state: "running",
                syntheticCoordinator: true,
              },
              true,
            );
          }
          const parentNodeId =
            parentRun && parentRun !== runId
              ? nodeId(context, parentRun)
              : (old?.parentNodeId ??
                turn?.input.rootNodeId ??
                NodeId.make(`dulli:subagent-root:${context.threadId}`));
          if (!old && !turn && !parentRun && !fallbackRootPublished) {
            fallbackRootPublished = true;
            yield* context.emit({
              type: "node.updated",
              driver: DRIVER,
              node: {
                id: parentNodeId,
                threadId: context.threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: parentNodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: false,
                providerThreadId: context.getProviderThread()?.id ?? null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            });
          }
          const usage = usageOf(view) ?? old?.usage;
          const proposedStatus =
            forceCurrent || lifecycle.has(event.kind) || !old
              ? stateOf(view, event.kind)
              : old.status;
          const status =
            old &&
            terminal(old.status) &&
            !terminal(proposedStatus) &&
            (event.replay || event.kind === "snapshot")
              ? old.status
              : proposedStatus;
          const model = string(view.model) ?? old?.model ?? null;
          const effort = string(view.thinking) ?? string(view.effort) ?? string(view.reasoning);
          const result = record(view.result);
          const summary =
            string(record(result.result).summary) ??
            string(result.reason) ??
            string(view.reason) ??
            old?.result ??
            null;
          const agent: OrchestrationV2Subagent = {
            id: nodeId(context, runId),
            threadId: context.threadId,
            runId: old?.runId ?? turn?.input.runId ?? null,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: DRIVER,
            providerInstanceId: context.instanceId,
            providerThreadId: context.getProviderThread()?.id ?? old?.providerThreadId ?? null,
            childThreadId: null,
            nativeTaskRef: {
              driver: DRIVER,
              nativeId: runId,
              strength: view.syntheticCoordinator === true ? "weak" : "strong",
            },
            prompt: string(view.task) ?? old?.prompt ?? "",
            ...((old?.parentPromptPreview ?? turn?.input.message.text)
              ? {
                  parentPromptPreview: (old?.parentPromptPreview ?? turn!.input.message.text).slice(
                    0,
                    200,
                  ),
                }
              : {}),
            title: string(workflow.label) ?? string(view.task) ?? old?.title ?? null,
            model,
            ...(model
              ? {
                  modelSelection: {
                    instanceId: context.instanceId,
                    model,
                    ...(effort
                      ? { options: [{ id: "reasoning", value: effort }] }
                      : old?.modelSelection?.options
                        ? { options: old.modelSelection.options }
                        : {}),
                  },
                }
              : {}),
            status,
            ...(string(view.progressNote) ? { progress: text(view.progressNote) } : {}),
            ...(usage ? { usage } : {}),
            ...(old?.workflow ? { workflow: old.workflow } : {}),
            result: summary,
            startedAt:
              old && terminal(old.status) && !terminal(status) ? now : (old?.startedAt ?? now),
            completedAt: terminal(status) ? (old?.completedAt ?? now) : null,
            updatedAt: now,
          };
          // Duration-only ticks must not append another whole lifecycle to the log.
          const comparable = (entry: OrchestrationV2Subagent) =>
            encodeJson({
              ...entry,
              updatedAt: null,
              usage: entry.usage ? { ...entry.usage, durationMs: null } : null,
            });
          if (!old || comparable(old) !== comparable(agent)) yield* publishAgent(agent);
          if (parentRun && parentRun !== runId) {
            const coordinator = agents.get(parentRun);
            if (coordinator) {
              const previous = coordinator.workflow ?? {
                name: string(workflow.name) ?? "Workflow",
                runHandles: { runId: parentRun },
                phases: [],
                agents: [],
              };
              const members = [...previous.agents];
              const at = members.findIndex((member) => member.agentId === runId);
              const phaseTitle = string(workflow.phase);
              const phases = [...previous.phases];
              let phaseIndex = phaseTitle
                ? phases.findIndex((phase) => phase.title === phaseTitle)
                : -1;
              if (phaseTitle && phaseIndex < 0) {
                phaseIndex = phases.length;
                phases.push({ index: phaseIndex, title: phaseTitle });
              }
              const member = {
                index: at < 0 ? members.length : members[at]!.index,
                agentId: runId,
                label: agent.title ?? runId,
                state: (status === "pending"
                  ? "queued"
                  : terminal(status)
                    ? status === "completed"
                      ? "completed"
                      : "failed"
                    : "running") as "queued" | "running" | "completed" | "failed",
                ...(phaseTitle ? { phaseTitle, phaseIndex } : {}),
                ...(model ? { model } : {}),
                ...(number(view.attempt) === undefined ? {} : { attempt: number(view.attempt)! }),
                ...(usage
                  ? {
                      totalTokens: usage.totalTokens,
                      ...(usage.toolUses === undefined ? {} : { toolCalls: usage.toolUses }),
                    }
                  : {}),
                ...(agent.prompt ? { prompt: agent.prompt } : {}),
                ...(agent.result ? { result: agent.result } : {}),
              };
              if (at < 0) members.push(member);
              else members[at] = member;
              const synthetic = coordinator.nativeTaskRef?.strength === "weak";
              const settled = members.every(
                (member) => member.state === "completed" || member.state === "failed",
              );
              const next = {
                ...coordinator,
                workflow: { ...previous, phases, agents: members },
                updatedAt: now,
                ...(synthetic &&
                !(terminal(coordinator.status) && (event.replay || event.kind === "snapshot"))
                  ? {
                      status: settled
                        ? members.some((member) => member.state === "failed")
                          ? ("failed" as const)
                          : ("completed" as const)
                        : ("running" as const),
                      completedAt: settled ? now : null,
                    }
                  : {}),
              };
              if (encodeJson(next.workflow) !== encodeJson(coordinator.workflow ?? null))
                yield* publishAgent(next);
            }
          }
        });

      const projectTranscript = (event: BridgeEvent) =>
        Effect.gen(function* () {
          const agent = event.runId ? agents.get(event.runId) : undefined;
          if (!agent || !event.activity) return;
          const activity = event.activity;
          let data = record(activity.data);
          let type = string(activity.type)?.replace(/^provider_tool_execution_/, "tool_execution_");
          if (!type) return;
          const message = record(data.message);
          if (type === "message_end" && message.role === "toolResult") {
            type = "tool_execution_end";
            data = {
              ...data,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              isError: message.isError,
              result: message.content,
            };
          }
          const liveOnly = activity.liveOnly === true;
          const at = Number.isFinite(Date.parse(event.timestamp))
            ? Date.parse(event.timestamp)
            : yield* Clock.currentTimeMillis;
          const now = DateTime.makeUnsafe(at);
          const toolId = string(data.toolCallId);
          const key = `${agent.id}:${type}:${toolId ?? "assistant"}`;
          let sequence = event.sequence;
          let parts = assistantParts(data.message);
          if (type === "message_update" || type === "message_end") {
            const current = live.get(agent.id);
            if (type === "message_update") {
              const delta = record(data.assistantMessageEvent);
              if (record(data.message).role !== "assistant") {
                parts = { text: current?.text ?? "", thinking: current?.thinking ?? "" };
                if (delta.type === "text_delta" && typeof delta.delta === "string")
                  parts.text += delta.delta;
                if (delta.type === "thinking_delta" && typeof delta.delta === "string")
                  parts.thinking += delta.delta;
                if (delta.type === "text_end" && typeof delta.content === "string")
                  parts.text = delta.content;
                if (delta.type === "thinking_end" && typeof delta.content === "string")
                  parts.thinking = delta.content;
              }
              sequence = current?.sequence ?? sequence;
              const liveText = text(parts.text);
              const remaining = TRANSCRIPT_BYTES - Buffer.byteLength(liveText);
              live.set(agent.id, {
                text: liveText,
                thinking: remaining > 32 ? text(parts.thinking, remaining) : "",
                sequence,
              });
            } else if (record(data.message).role === "assistant") {
              sequence = current?.sequence ?? sequence;
              live.delete(agent.id);
            }
          }
          if (liveOnly && publishedAt.has(key) && at - publishedAt.get(key)! < 1000) return;
          if (liveOnly) publishedAt.set(key, at);
          const emitItem = (
            identity: string,
            fields:
              | {
                  type: "user_message";
                  text: string;
                  messageId: MessageId;
                  attachments: [];
                  createdBy: "agent";
                  creationSource: "provider";
                  inputIntent: "turn_start";
                }
              | { type: "reasoning"; text: string; streaming: boolean }
              | {
                  type: "assistant_message";
                  text: string;
                  streaming: boolean;
                  messageId: MessageId;
                }
              | { type: "dynamic_tool"; toolName: string | null; input: unknown; output?: unknown },
          ) =>
            Effect.gen(function* () {
              const retained = [...items.values()].filter(
                (item) => item.nodeId === agent.id && item.id.includes(":transcript:"),
              );
              const nativeId = `${event.managerId}:${event.sequence}:${fields.type}:${fields.type === "dynamic_tool" ? identity : ""}`;
              if (retained.some((item) => item.nativeItemRef?.nativeId === nativeId)) return;
              const fingerprint = `${event.managerId}:${identity}`;
              const matching = retained.find(
                (item) => item.nativeItemRef?.fingerprint === fingerprint,
              );
              const oldest = retained.toSorted(
                (a, b) =>
                  DateTime.toEpochMillis(a.updatedAt) - DateTime.toEpochMillis(b.updatedAt) ||
                  a.ordinal - b.ordinal,
              )[0];
              // A replay older than the retained window cannot evict newer entries.
              if (
                !matching &&
                retained.length >= TRANSCRIPT_SLOTS &&
                oldest &&
                DateTime.toEpochMillis(oldest.updatedAt) > at
              )
                return;
              const id =
                matching?.id ??
                (retained.length >= TRANSCRIPT_SLOTS
                  ? oldest!.id
                  : TurnItemId.make(`${agent.id}:transcript:${retained.length}`));
              const old = items.get(id);
              if (old && DateTime.toEpochMillis(old.updatedAt) > at) return;
              const done =
                (fields.type === "dynamic_tool"
                  ? type.endsWith("execution_end")
                  : type.endsWith("_end")) || terminal(agent.status);
              let item: OrchestrationV2TurnItem = {
                id,
                threadId: context.threadId,
                runId: agent.runId,
                nodeId: agent.id,
                providerThreadId: agent.providerThreadId,
                providerTurnId: items.get(itemId(agent.id))?.providerTurnId ?? null,
                nativeItemRef: { driver: DRIVER, nativeId, strength: "strong", fingerprint },
                parentItemId: itemId(agent.id),
                ordinal: event.sequence,
                status: done ? (data.isError === true ? "failed" : "completed") : "running",
                title: null,
                startedAt: old?.startedAt ?? now,
                completedAt: done ? now : null,
                updatedAt: now,
                ...fields,
                ...(fields.type === "dynamic_tool" && old?.type === "dynamic_tool"
                  ? {
                      toolName: fields.toolName ?? old.toolName,
                      input: data.args === undefined ? old.input : fields.input,
                      output:
                        data.result === undefined &&
                        data.partialResult === undefined &&
                        data.output === undefined
                          ? old.output
                          : fields.output,
                    }
                  : {}),
              };
              if (item.type === "dynamic_tool")
                item = {
                  ...item,
                  output: text(
                    item.output,
                    TRANSCRIPT_BYTES - Buffer.byteLength(String(item.input ?? "")),
                  ),
                };
              const contentBytes = (value: OrchestrationV2TurnItem) =>
                Buffer.byteLength(
                  value.type === "assistant_message" ||
                    value.type === "reasoning" ||
                    value.type === "user_message"
                    ? value.text
                    : value.type === "dynamic_tool"
                      ? String(value.input ?? "") + String(value.output ?? "")
                      : "",
                );
              let bytes =
                contentBytes(item) +
                retained.reduce(
                  (sum, value) => sum + (value.id === id ? 0 : contentBytes(value)),
                  0,
                );
              for (const previous of retained.toSorted(
                (a, b) =>
                  DateTime.toEpochMillis(a.updatedAt) - DateTime.toEpochMillis(b.updatedAt) ||
                  a.ordinal - b.ordinal,
              )) {
                if (bytes <= TRANSCRIPT_BYTES) break;
                if (previous.id === id) continue;
                bytes -= contentBytes(previous);
                const cleared: OrchestrationV2TurnItem =
                  previous.type === "dynamic_tool"
                    ? { ...previous, input: "", output: "", status: "completed" }
                    : previous.type === "assistant_message" || previous.type === "reasoning"
                      ? { ...previous, text: "", streaming: false, status: "completed" }
                      : previous.type === "user_message"
                        ? { ...previous, text: "" }
                        : previous;
                items.set(previous.id, cleared);
                yield* context.emit({
                  type: "turn_item.updated",
                  driver: DRIVER,
                  turnItem: cleared,
                });
              }
              items.set(id, item);
              yield* context.emit({ type: "turn_item.updated", driver: DRIVER, turnItem: item });
            });
          if (type === "message_end" && message.role === "user") {
            const content = Array.isArray(message.content)
              ? message.content
                  .map((part) =>
                    record(part).type === "image" ? "[image]" : (string(record(part).text) ?? ""),
                  )
                  .join("\n")
              : message.content;
            yield* emitItem(`user:${sequence}`, {
              type: "user_message",
              text: text(content),
              messageId: MessageId.make(`${agent.id}:user:${sequence}`),
              attachments: [],
              createdBy: "agent",
              creationSource: "provider",
              inputIntent: "turn_start",
            });
          } else if (type === "message_update" || type === "message_end") {
            if (parts.thinking)
              yield* emitItem(`message:${sequence}:thinking`, {
                type: "reasoning",
                text: text(parts.thinking),
                streaming: type === "message_update" && !terminal(agent.status),
              });
            if (parts.text)
              yield* emitItem(`message:${sequence}:text`, {
                type: "assistant_message",
                text: text(parts.text),
                streaming: type === "message_update" && !terminal(agent.status),
                messageId: MessageId.make(`${agent.id}:message:${sequence % 500}`),
              });
            for (const part of Array.isArray(message.content) ? message.content.map(record) : []) {
              if (part.type !== "toolCall") continue;
              yield* emitItem(`tool:${string(part.id) ?? sequence}`, {
                type: "dynamic_tool",
                toolName: string(part.name) ?? "tool",
                input: text(part.arguments ?? part.args, 64 * 1024),
                output: "",
              });
            }
          } else if (type.startsWith("tool_execution_")) {
            // Tool updates retain their slot by native tool id, not by arrival order.
            const input = text(data.args, 64 * 1024);
            yield* emitItem(`tool:${toolId ?? sequence}`, {
              type: "dynamic_tool",
              toolName: string(data.toolName) ?? null,
              input,
              output: text(
                toolOutput(data.result ?? data.partialResult ?? data.output ?? data.error ?? ""),
                TRANSCRIPT_BYTES - Buffer.byteLength(input),
              ),
            });
          }
        });
      const handleEvent = (event: BridgeEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (stopped) return;
          if (event.kind === "control_result") {
            const waiter = event.control?.requestId
              ? waiters.get(event.control.requestId)
              : undefined;
            if (waiter && event.control) yield* Deferred.succeed(waiter, event.control);
            return;
          }
          if (event.kind === "snapshot" && event.snapshot) {
            const runs = Array.isArray(event.snapshot.runs) ? event.snapshot.runs.map(record) : [];
            // Never emit synthetic starts then historical lifecycles: only current
            // states are persisted, before the historical transcript is replayed.
            for (const view of runs)
              yield* projectView(
                { ...event, runId: string(view.runId), kind: "snapshot" },
                view,
                true,
              );
            for (const coordinator of agents.values()) {
              if (!coordinator.workflow || !terminal(coordinator.status)) continue;
              for (const child of agents.values()) {
                if (child.parentNodeId === coordinator.id && !terminal(child.status))
                  yield* publishAgent({
                    ...child,
                    status: coordinator.status === "failed" ? "failed" : "interrupted",
                    completedAt: coordinator.completedAt,
                    updatedAt: coordinator.updatedAt,
                  });
              }
            }
            const events = Array.isArray(event.snapshot.events) ? event.snapshot.events : [];
            for (const candidate of events) {
              const decoded = decodeEventRecord(candidate);
              if (Option.isSome(decoded) && !lifecycle.has(decoded.value.kind))
                yield* projectTranscript(decoded.value);
            }
            return;
          }
          if (event.view) yield* projectView(event, event.view);
          yield* projectTranscript(event);
          if (event.runId && ["terminal", "killed", "interrupted"].includes(event.kind)) {
            const agent = agents.get(event.runId);
            if (agent) {
              for (const child of agents.values()) {
                if (child.parentNodeId === agent.id && !terminal(child.status))
                  yield* publishAgent({
                    ...child,
                    status: agent.status === "failed" ? "failed" : "interrupted",
                    completedAt: agent.completedAt,
                    updatedAt: agent.updatedAt,
                  });
              }
              const pending = live.get(agent.id);
              if (pending)
                yield* projectTranscript({
                  ...event,
                  kind: "activity",
                  activity: {
                    type: "message_end",
                    data: {
                      message: {
                        role: "assistant",
                        content: [
                          { type: "text", text: pending.text },
                          { type: "thinking", thinking: pending.thinking },
                        ],
                      },
                    },
                  },
                });
              live.delete(agent.id);
              for (const key of publishedAt.keys())
                if (key.startsWith(`${agent.id}:`)) publishedAt.delete(key);
            }
          }
        });
      return {
        notify: [
          {
            prefix: SUBAGENT_PREFIX,
            handle: (payload: string) => {
              const decoded =
                payload.length <= 8 * 1024 * 1024 ? decodeEvent(payload) : Option.none();
              return Option.isSome(decoded) ? handleEvent(decoded.value) : Effect.void;
            },
          },
        ],
        onStart: () =>
          Effect.gen(function* () {
            token = yield* dependencies.controls.register(context.threadId, control);
            // onStart runs outside the notify pump, so replay can await its RPC ack.
            yield* Effect.gen(function* () {
              if (yield* advertised)
                yield* context.rpc.request({
                  type: "prompt",
                  message: '/subagents-rpc {"action":"replay"}',
                });
            }).pipe(Effect.ignore);
          }),
        onStop: (reason) =>
          Effect.gen(function* () {
            stopped = true;
            if (token) yield* dependencies.controls.unregister(context.threadId, token);
            for (const waiter of waiters.values())
              yield* Deferred.fail(
                waiter,
                fail("Dulli session ended before the child control completed."),
              );
            waiters.clear();
            live.clear();
            publishedAt.clear();
            // The terminal owns shared children. Detaching only unregisters
            // local controls; reconnect replay supplies their current status.
            if (reason === "detached") return;
            const now = yield* DateTime.now;
            for (const agent of agents.values()) {
              if (!terminal(agent.status))
                yield* publishAgent({
                  ...agent,
                  status: "interrupted",
                  completedAt: now,
                  updatedAt: now,
                });
            }
          }),
        hasPendingBackgroundWork: () =>
          [...agents.values()].some((agent) =>
            ["pending", "running", "waiting"].includes(agent.status),
          ),
        stopSubagent: (input) =>
          Effect.gen(function* () {
            const agent = agents.get(input.nativeTaskId);
            if (agent && terminal(agent.status)) return;
            if (
              input.requestedAt &&
              agent?.startedAt &&
              DateTime.toEpochMillis(agent.startedAt) > DateTime.toEpochMillis(input.requestedAt)
            )
              return;
            yield* control(
              {
                threadId: context.threadId,
                taskId: input.nativeTaskId,
                action: "stop",
              },
              input.requestedAt,
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProtocolError({ driver: DRIVER, detail: cause.message, cause }),
            ),
          ),
      };
    });

export const makeFactory = Effect.gen(function* () {
  const controls = yield* DulliSubagents;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return makeSubagentFactory({
    controls,
    read: (threadId) =>
      Effect.gen(function* () {
        const { subagents } = yield* projections.getThreadRecords(threadId, ["subagents"]);
        const nodeIds = subagents
          .filter((agent) => agent.driver === DRIVER && agent.id.startsWith("dulli:subagent:"))
          .map((agent) => agent.id);
        if (nodeIds.length === 0) return { subagents, turnItems: [] };
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemNodeIds: nodeIds,
        });
        return { subagents, turnItems };
      }).pipe(Effect.orElseSucceed(() => ({ subagents: [], turnItems: [] }))),
  });
});
