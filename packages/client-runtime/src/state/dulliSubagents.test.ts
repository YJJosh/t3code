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
import {
  agentActivityText,
  deriveDulliAgentInspector,
  dulliTranscriptEntries,
  dulliToolPreview,
  workflowIsLive,
  workflowMembers,
  workflowStatus,
} from "./dulliSubagents.ts";
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
    expect(model.transcript(child)).toMatchObject([
      { type: "assistant_message", text: "first" },
      { type: "assistant_message", text: "second" },
    ]);
    expect(model.canControl(child)).toBe(true);
    expect(model.canControl(root)).toBe(false);
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

const tool = (
  nodeId: NodeId,
  id: string,
  ordinal: number,
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> => {
  const {
    type: _type,
    messageId: _messageId,
    text: _text,
    streaming: _streaming,
    ...base
  } = item(nodeId, id, ordinal) as Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>;
  return {
    ...base,
    type: "dynamic_tool",
    toolName: "read",
    input: "file.ts",
    output: "file contents",
    ...fields,
  };
};
const inspector = (runs: OrchestrationV2Subagent[], transcript: OrchestrationV2TurnItem[] = []) =>
  deriveDulliAgentInspector({
    dulliRuns: runs,
    dulliTranscript: transcript,
    messages: [prompt],
    providerSessions: [session],
  });

describe("Dulli inspector presentation", () => {
  it("keeps actual workflow members nested under one prompt and unions declared and observed phases", () => {
    const root = agent("workflow", {
      workflow: {
        name: "Review",
        phases: [
          { index: 0, title: "Read" },
          { index: 2, title: "Next" },
        ],
        agents: [
          { index: 0, agentId: "child", label: "Snapshot label", state: "running", phaseIndex: 0 },
          {
            index: 1,
            agentId: "observer",
            label: "Observer",
            state: "completed",
            phaseIndex: 1,
            phaseTitle: "Observed",
          },
          {
            index: 2,
            agentId: "not-yet-seen",
            label: "Do not invent a child",
            state: "queued",
            phaseIndex: 2,
          },
        ],
      },
      usage: { totalTokens: 100, toolUses: 7 },
    });
    const child = agent("child", {
      parentNodeId: root.id,
      title: "Actual reader",
      usage: { totalTokens: 40, toolUses: 2 },
    });
    const observer = agent("observer", {
      parentNodeId: root.id,
      status: "completed",
      usage: { totalTokens: 60, toolUses: 5 },
      completedAt: now,
    });
    const loose = agent("loose", {
      parentNodeId: root.id,
      status: "failed",
      result: "No matching phase",
    });
    const direct = agent("direct", { usage: { totalTokens: 5 } });
    const { presentation } = inspector([root, child, observer, loose, direct]);
    expect(presentation.batches).toHaveLength(1);
    expect(presentation.batches[0]?.prompt).toBe(prompt.text);
    expect(presentation.batches[0]?.directAgents.map((agent) => agent.id)).toEqual([direct.id]);
    expect(presentation.batches[0]?.workflows).toHaveLength(1);
    const group = presentation.workflows[0]!;
    expect(
      group.phases.map((phase) => [
        phase.index,
        phase.title,
        phase.state,
        phase.activeCount,
        phase.settledCount,
      ]),
    ).toEqual([
      [0, "Read", "running", 1, 0],
      [1, "Observed", "done", 0, 1],
      [2, "Next", "pending", 0, 0],
    ]);
    expect(group.phases[0]?.members[0]).toMatchObject({
      id: child.id,
      title: "Actual reader",
      model: "child-model",
      effort: "high",
      prompt: "Child prompt",
      workflowName: "Review",
      phaseTitle: "Read",
      startedAt: "2026-01-01T00:00:00.000Z",
      usage: { totalTokens: 40, toolUses: 2 },
    });
    expect(workflowMembers(group).map((member) => member.id)).toEqual([
      child.id,
      observer.id,
      loose.id,
    ]);
    expect(group.unphasedMembers.map((member) => member.id)).toEqual([loose.id]);
    expect(presentation.totalTokens).toBe(105); // Coordinator includes member usage.
    expect(presentation).toMatchObject({ runningCount: 2, settledCount: 2, waitingCount: 0 });
  });

  it("prefers progress, then the running tool over a finished tool, then outcome text", () => {
    const child = agent("reader", { result: "Earlier activation" });
    const tools = [
      tool(child.id, "running", 1, { toolName: "bash", status: "running", completedAt: null }),
      tool(child.id, "completed", 2),
    ];
    expect(
      agentActivityText(
        inspector([{ ...child, progress: "Checking tests" }], tools).presentation.agents[0]!,
      ),
    ).toBe("Checking tests");
    expect(agentActivityText(inspector([child], tools).presentation.agents[0]!)).toBe("▸ bash");
    expect(
      agentActivityText(
        inspector([child], [tool(child.id, "completed", 2)]).presentation.agents[0]!,
      ),
    ).toBe("▸ read");
    expect(
      agentActivityText(
        inspector(
          [{ ...child, status: "failed", result: "Child failed", progress: "Stale progress" }],
          tools,
        ).presentation.agents[0]!,
      ),
    ).toBe("Child failed");
    expect(agentActivityText(inspector([child]).presentation.agents[0]!)).toBe(
      "Earlier activation",
    );
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "settles a workflow from %s members without double-counting usage",
    (status) => {
      const root = agent("workflow", {
        workflow: { phases: [], agents: [] },
        nativeTaskRef: { driver, nativeId: "workflow", strength: "weak" },
      });
      const child = agent("child", { parentNodeId: root.id, status, usage: { totalTokens: 12 } });
      const model = inspector([root, child]).presentation;
      const group = model.workflows[0]!;
      expect(workflowStatus(group)).toBe(status === "interrupted" ? "cancelled" : status);
      expect(workflowIsLive(group)).toBe(false);
      expect(model.totalTokens).toBe(12);
      const cancelled = inspector([
        { ...root, status: "cancelled" },
        { ...child, status: "completed" },
      ]).presentation.workflows[0]!;
      expect(workflowStatus(cancelled)).toBe("cancelled");
    },
  );

  // Settled retained children do not mean a native workflow has finished.
  it.each(["running", "waiting", "interrupted", "failed", "completed"] as const)(
    "honors a real Pi coordinator's %s state between phases or after interruption",
    (status) => {
      const root = agent("workflow", { status, workflow: { phases: [], agents: [] } });
      const child = agent("child", { parentNodeId: root.id, status: "completed" });
      const group = inspector([root, child]).presentation.workflows[0]!;
      expect(workflowStatus(group)).toBe(status);
      expect(workflowIsLive(group)).toBe(status === "running" || status === "waiting");
    },
  );

  it("uses per-run revisions and merges newer live items without losing detailed output at the same revision", () => {
    const child = agent("child");
    const detailed = tool(child.id, "read", 1);
    const omitted = { ...detailed, output: undefined, outputOmitted: true };
    const newer = {
      ...item(child.id, "message", 2),
      updatedAt: DateTime.add(now, { seconds: 1 }),
      text: "Latest",
    } as OrchestrationV2TurnItem;
    const model = deriveDulliAgentInspector({
      dulliRuns: [child],
      dulliTranscript: [omitted, newer],
      dulliTranscriptRevisions: { [child.id]: "child-v2", other: "other-v100" },
      messages: [],
      providerSessions: [session],
    });
    expect(model.revision(child.id)).toBe("child-v2");
    expect(model.transcript(child, [detailed, item(child.id, "message", 2)])).toEqual([
      detailed,
      newer,
    ]);
    expect(
      model.transcript(child, [
        { ...detailed, updatedAt: DateTime.add(now, { seconds: 2 }), output: "newer history" },
      ])[0],
    ).toMatchObject({ output: "newer history" });
  });

  it("does not keep a running label or controls for stale retained records", () => {
    const child = agent("child");
    const model = deriveDulliAgentInspector({
      dulliRuns: [child],
      dulliTranscript: [tool(child.id, "live", 1, { status: "running" })],
      messages: [],
      providerSessions: [],
    });
    const runtime = model.presentation.agents[0]!;
    expect(runtime.status).toBe("interrupted");
    expect(model.canControl(runtime.source)).toBe(false);
    expect(
      dulliTranscriptEntries(model.transcript(runtime.source), runtime.prompt, false)[0],
    ).toMatchObject({ kind: "tool", live: false, status: "interrupted" });
  });
});

describe("Dulli conversation presentation", () => {
  it("maps messages, reasoning, and structured tool previews with live/settled states", () => {
    const child = agent("child");
    const user = {
      ...item(child.id, "user", 0),
      type: "user_message",
      text: "Follow-up",
      attachments: [],
    } as OrchestrationV2TurnItem;
    const reasoning = {
      ...item(child.id, "thinking", 1),
      type: "reasoning",
      text: "Tracing the boundary",
      status: "running",
    } as OrchestrationV2TurnItem;
    const entries = dulliTranscriptEntries([
      user,
      reasoning,
      item(child.id, "answer", 2),
      tool(child.id, "tool", 3, {
        status: "running",
        input: { path: "file.ts" },
        output: { content: "Found it" },
      }),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.live])).toEqual([
      ["user", false],
      ["reasoning", true],
      ["assistant", false],
      ["tool", true],
    ]);
    expect(entries[3]).toMatchObject({
      kind: "tool",
      name: "read",
      input: '{\n  "path": "file.ts"\n}',
      output: '{\n  "content": "Found it"\n}',
    });
    expect(dulliToolPreview("x".repeat(9000))).toHaveLength(8020);
  });

  it("shows empty-input tool calls instead of hiding active work", () => {
    const child = agent("child");
    const model = inspector(
      [child],
      [tool(child.id, "empty", 1, { input: "", output: "", status: "running" })],
    );
    expect(dulliTranscriptEntries(model.transcript(child))).toMatchObject([
      { kind: "tool", name: "read", live: true },
    ]);
  });

  it("does not repeat Pi's wrapped originating prompt but keeps a later quoted reply", () => {
    const child = agent("child");
    const task =
      "Monitor the file every twenty seconds using only read-only operations and report whether it changed.";
    const user = (id: string, text: string): OrchestrationV2TurnItem =>
      ({
        ...item(child.id, id, 0),
        type: "user_message",
        text,
        attachments: [],
      }) as OrchestrationV2TurnItem;
    const entries = dulliTranscriptEntries(
      [
        user("origin", `Task:\n\n${task}\n\nRemember: finish with exactly one JSON result object.`),
        item(child.id, "assistant", 1),
        user("reply", `Follow-up quoting the task: ${task}`),
      ],
      task,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["assistant", "reply"]);
    expect(dulliTranscriptEntries([user("origin", task)], `${task.slice(0, 70)}…`)).toEqual([]);
  });
});
