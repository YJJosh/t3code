import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { buildBoundedThreadProjection } from "../../orchestration-v2/threadHistoryPaging.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as McpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import * as AdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Schedules from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../../secrets/SecretRequests.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";

it.effect.each([
  { name: "memory", storeLayer: ProjectionStore.layerMemory },
  { name: "sqlite", storeLayer: ProjectionStore.layer.pipe(Layer.provide(Sqlite.layerMemory)) },
] as const)(
  "loads selected Dulli node history outside the paged parent snapshot ($name)",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("history-parent");
      const instanceId = ProviderInstanceId.make("dulli");
      const driver = ProviderDriverKind.make("dulli");
      const subagentId = NodeId.make("dulli:subagent:history-child");
      yield* store.apply({
        id: EventId.make("created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project"),
          title: "Parent",
          historyOrigin: "v1_import",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("agent"),
        type: "dulli-run.updated",
        threadId,
        occurredAt: now,
        driver,
        payload: {
          id: subagentId,
          threadId,
          runId: null,
          parentNodeId: NodeId.make("root"),
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: { driver, nativeId: "child", strength: "strong" },
          prompt: "Investigate",
          title: "Child",
          model: "default",
          status: "completed",
          result: "Done",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
      const childAnswer = `${subagentId}:transcript:0`;
      const lateChildAnswer = `${subagentId}:transcript:1`;
      for (const [id, nodeId, ordinal] of [
        [childAnswer, subagentId, 1],
        ["parent-answer", NodeId.make("root"), 99],
        [lateChildAnswer, subagentId, 100],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:${id}`),
          type: nodeId === subagentId ? "dulli-transcript.updated" : "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            parentItemId: null,
            nativeItemRef: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            text: id,
            messageId: MessageId.make(id),
            streaming: false,
          },
        });
      }
      const projection = yield* store.getThreadProjection(threadId);
      // REVIEW: Persisted child history must be available to the inspector but
      // absent from both the full and SQL-windowed parent conversation.
      assert.deepEqual(
        projection.visibleTurnItems.map((row) => row.item.id),
        ["parent-answer"],
      );
      const windowed = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 1 });
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => row.item.id),
        ["parent-answer"],
      );
      const bounded = buildBoundedThreadProjection({
        projection,
        snapshotSequence: 3,
        policy: { maxItems: 1, maxUserTurns: 1, maxEncodedBytes: 1024 * 1024 },
      });
      assert.isFalse(bounded.projection.turnItems.some((item) => item.id === childAnswer));
      const boundaryRunId = RunId.make("fork-boundary");
      yield* store.apply({
        id: EventId.make("boundary-run"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: boundaryRunId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("boundary-prompt"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const forkThreadId = ThreadId.make("history-fork");
      yield* store.apply({
        id: EventId.make("fork-created"),
        type: "thread.created",
        threadId: forkThreadId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          id: forkThreadId,
          forkedFrom: { type: "run", threadId, runId: boundaryRunId },
        },
      });
      const fork = yield* store.getThreadProjection(forkThreadId);
      assert.deepEqual(
        fork.visibleTurnItems.map((row) => row.item.id),
        ["parent-answer", `turn-item:fork:${forkThreadId}`],
      );
      const forkPage = yield* store.getTimelinePage(forkThreadId, { limit: 10, view: "activity" });
      assert.deepEqual(
        forkPage.items.map((row) => row.item.id),
        fork.visibleTurnItems.map((row) => row.item.id),
      );
      // Exercise the actual upstream MCP task lookup against the isolated store.
      yield* Effect.gen(function* () {
        const service = yield* McpService.OrchestratorMcpService;
        const scope = {
          environmentId: EnvironmentId.make("isolation"),
          requestNamespace: "isolation",
          thread: { threadId, providerSessionId: "session", providerInstanceId: instanceId },
          client: undefined,
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 1,
        };
        const status = yield* service.taskStatus(scope, subagentId).pipe(Effect.flip);
        assert.equal(status.code, "task_not_found");
        const cancel = yield* service.cancelTask(scope, { taskId: subagentId }).pipe(Effect.flip);
        assert.equal(cancel.code, "task_not_found");
      }).pipe(
        Effect.provide(
          McpService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeCrypto.layer,
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadRecords: (id, fields, filter) =>
                    store
                      .getThreadRecords(id, fields, filter)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                        ),
                      ),
                }),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                Layer.mock(AdapterRegistry.ProviderAdapterRegistryV2)({}),
                Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
                Layer.mock(Projects.ProjectService)({}),
                Layer.mock(Schedules.ScheduledTaskService)({}),
                Layer.mock(Secrets.SecretRequests)({}),
                Layer.mock(Git.GitVcsDriver)({}),
                ServerSettings.layerTest(),
              ),
            ),
          ),
        ),
      );
      const serviceLayer = ThreadManagement.layer.pipe(
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (id, fields, filter) =>
              store
                .getThreadRecords(id, fields, filter)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                  ),
                ),
          }),
        ),
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagement.ThreadManagementService;
        const history = yield* service.getSubagentTranscript({ threadId, subagentId });
        assert.deepEqual(
          history.items.map((item) => item.id),
          [childAnswer, lateChildAnswer],
        );
        assert.deepEqual(
          (yield* service.getSubagentTranscript({ threadId, subagentId: NodeId.make("missing") }))
            .items,
          [],
        );
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(storeLayer)),
);
