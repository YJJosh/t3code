import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  MessageId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveDulliAgentInspector, dulliTranscriptText } from "./dulliSubagents.ts";
import { projectedSubagentsToRuntime } from "./subagentRuntime.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const instanceId = ProviderInstanceId.make("dulli-custom");
const driver = ProviderDriverKind.make("dulli");
const threadId = ThreadId.make("parent");
const runId = RunId.make("run");
const agent = (
  id: string,
  fields: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(`dulli:subagent:${id}`),
  threadId,
  runId,
  parentNodeId: NodeId.make("root"),
  origin: "provider_native",
  createdBy: "agent",
  driver,
  providerInstanceId: instanceId,
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: { driver, nativeId: id, strength: "strong" },
  prompt: "Child prompt",
  title: id,
  model: "child-model",
  modelSelection: {
    instanceId,
    model: "child-model",
    options: [{ id: "reasoning", value: "high" }],
  },
  status: "running",
  result: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  ...fields,
});
const prompt: OrchestrationV2ConversationMessage = {
  id: MessageId.make("prompt"),
  threadId,
  runId,
  nodeId: NodeId.make("root"),
  role: "user",
  text: "Review this change",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
};
const session = { providerInstanceId: instanceId, status: "running" as const, updatedAt: now };
const item = (nodeId: NodeId, id: string, ordinal: number): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId,
  providerThreadId: null,
  providerTurnId: null,
  parentItemId: TurnItemId.make(`${nodeId}:task`),
  nativeItemRef: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "assistant_message",
  messageId: MessageId.make(id),
  text: id,
  streaming: false,
});

describe("Dulli v2 inspector", () => {
  it("leaves app-owned Dulli delegations in the ordinary navigable child population", () => {
    const native = agent("native");
    const delegated = agent("delegated", {
      origin: "app_owned",
      childThreadId: ThreadId.make("delegated-thread"),
      nativeTaskRef: null,
    });
    const model = deriveDulliAgentInspector({
      dulliRuns: [native],
      messages: [],
      dulliTranscript: [],
      providerSessions: [session],
    });
    expect(model.agents).toEqual([native]);
    expect(projectedSubagentsToRuntime([delegated])[0]?.childThreadId).toEqual("delegated-thread");
  });

  it("groups workflow roots by parent prompt, selects actual child data, and excludes unrelated transcript items", () => {
    const root = agent("workflow", {
      model: "coordinator-model",
      workflow: {
        name: "Review",
        phases: [{ index: 0, title: "Read" }],
        agents: [{ index: 0, agentId: "child", label: "Reader", state: "running", phaseIndex: 0 }],
      },
    });
    const child = agent("child", { parentNodeId: root.id, usage: { totalTokens: 42 } });
    const model = deriveDulliAgentInspector({
      dulliRuns: [root, child],
      messages: [prompt],
      providerSessions: [session],
      dulliTranscript: [
        item(child.id, "second", 2),
        item(NodeId.make("other"), "unrelated", 0),
        item(child.id, "first", 1),
      ],
    });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.prompt).toBe("Review this change");
    expect(model.groups[0]?.agents).toEqual([root]);
    expect(model.children(root)).toEqual([child]);
    expect(model.transcript(child).map(dulliTranscriptText)).toEqual(["first", "second"]);
    expect(model.canControl(child)).toBe(true);
    const runtime = projectedSubagentsToRuntime([child])[0];
    expect(runtime?.model).toBe("child-model");
    expect(runtime?.effort).toBe("high");
    expect(runtime?.usage?.totalTokens).toBe(42);
  });

  it("does not expose controls or a running label after the latest session stops, including custom instances", () => {
    const child = agent("child");
    const model = deriveDulliAgentInspector({
      dulliRuns: [child],
      messages: [],
      dulliTranscript: [],
      providerSessions: [
        session,
        { ...session, status: "stopped", updatedAt: DateTime.makeUnsafe("2026-01-01T00:01:00Z") },
      ],
    });
    expect(model.agents[0]?.status).toBe("interrupted");
    expect(model.canControl(model.agents[0]!)).toBe(false);
    expect(child.status).toBe("running"); // Never mutate durable state on the client.
  });

  it("bounds roster and transcript presentation and keeps synthetic workflows non-controllable", () => {
    const child = agent("child", {
      nativeTaskRef: { driver, nativeId: "workflow", strength: "weak" },
    });
    const model = deriveDulliAgentInspector({
      dulliRuns: [child, ...Array.from({ length: 150 }, (_, i) => agent(`other-${i}`))],
      messages: [],
      providerSessions: [session],
      dulliTranscript: Array.from({ length: 1100 }, (_, i) => item(child.id, String(i), i)),
    });
    expect(model.agents).toHaveLength(100);
    expect(model.transcript(child)).toHaveLength(1000);
    expect(model.transcript(child)[0]?.ordinal).toBe(100);
    expect(model.canControl(child)).toBe(false);
  });
});
