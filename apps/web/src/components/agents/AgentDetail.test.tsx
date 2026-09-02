import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text, isStreaming }: { text: string; isStreaming?: boolean }) => (
    <div data-markdown-streaming={isStreaming ? "true" : undefined}>{text}</div>
  ),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { AgentDetail } from "./AgentDetail";
import { AgentsRoster } from "./AgentsRoster";
import { WorkflowDetail } from "./WorkflowDetail";

function makeAgent(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "agent-1",
    kind: "subagent",
    title: "Boundary reviewer",
    prompt: "Review the provider boundary",
    role: "reviewer",
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
    status: "running",
    activationCount: 1,
    usage: { totalTokens: 1200, toolUses: 2 },
    progress: null,
    lastToolName: "read",
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    transcript: {
      items: [
        { sourceId: "manager:1", kind: "user", text: "Inspect PiAdapter.ts" },
        {
          sourceId: "manager:2",
          kind: "assistant",
          parts: [
            { type: "thinking", text: "I should trace the event bridge." },
            { type: "toolCall", id: "call-1", name: "read", argsPreview: "PiAdapter.ts" },
            { type: "text", text: "The bridge projects canonical task events." },
          ],
        },
        {
          sourceId: "manager:3",
          kind: "toolResult",
          id: "call-1",
          name: "read",
          isError: false,
          outputPreview: "export function projectPiTaskBridgeEvent",
        },
      ],
      droppedItems: 0,
      liveAssistant: { text: "Now checking persistence", thinking: "Follow the activity row" },
      liveTools: [{ id: "call-2", name: "bash", argsPreview: "vp test" }],
    },
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("AgentDetail", () => {
  it("renders a main-chat-like persisted and live child transcript", () => {
    const html = renderToStaticMarkup(
      <AgentDetail
        agent={makeAgent()}
        environmentId={null}
        threadId={null}
        controlsEnabled={false}
      />,
    );

    expect(html).toContain("Inspect PiAdapter.ts");
    expect(html).toContain("I should trace the event bridge.");
    expect(html).toContain("The bridge projects canonical task events.");
    expect(html).toContain("export function projectPiTaskBridgeEvent");
    expect(html).toContain("Now checking persistence");
    expect(html).toContain("Follow the activity row");
    expect(html).toContain("vp test");
    expect(html).toContain('data-markdown-streaming="true"');
  });

  it("does not repeat Pi's wrapped originating prompt", () => {
    const prompt =
      "Monitor the file every twenty seconds using only read-only operations and report whether it changed.";
    const html = renderToStaticMarkup(
      <AgentDetail
        agent={makeAgent({
          prompt,
          transcript: {
            items: [
              {
                sourceId: "manager:1",
                kind: "user",
                text: `Task:\n\n${prompt}\n\nRemember: finish with exactly one JSON result object.`,
              },
              {
                sourceId: "manager:2",
                kind: "user",
                text: `Follow-up quoting the task: ${prompt}`,
              },
            ],
            droppedItems: 0,
            liveAssistant: null,
            liveTools: [],
          },
        })}
        environmentId={null}
        threadId={null}
        controlsEnabled={false}
      />,
    );

    expect(html.split(prompt)).toHaveLength(3);
    expect(html).toContain("Follow-up quoting the task:");
    expect(html).not.toContain("Remember: finish with exactly one JSON result object.");
  });

  it("shows steer and stop controls for a live agent", () => {
    const html = renderToStaticMarkup(
      <AgentDetail
        agent={makeAgent({
          transcript: { items: [], droppedItems: 0, liveAssistant: null, liveTools: [] },
        })}
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        controlsEnabled
      />,
    );

    expect(html).toContain("Send guidance to this agent");
    expect(html).toContain('aria-label="Stop agent"');
    expect(html).toContain('aria-label="Steer"');
  });

  it("links workflow children back to their workflow", () => {
    const html = renderToStaticMarkup(
      <AgentDetail
        agent={makeAgent({ workflowName: "release-review", phaseTitle: "Validation" })}
        environmentId={null}
        threadId={null}
        controlsEnabled={false}
        onBack={() => undefined}
        backLabel="Back to workflow"
      />,
    );

    expect(html).toContain('aria-label="Back to workflow"');
    expect(html).toContain("release-review");
    expect(html).toContain("Validation");
  });
});

describe("AgentsRoster", () => {
  it("shows one workflow row without expanding phases or child agents in the roster", () => {
    const member = makeAgent({
      id: "nested-agent",
      title: "Nested implementation agent",
      kind: "workflow_agent",
      parentAgentId: "workflow-roster",
      workflowName: "release-review",
      phaseIndex: 0,
      phaseTitle: "Implementation",
    });
    const workflow = makeAgent({
      id: "workflow-roster",
      title: "Release review",
      kind: "workflow",
      workflowName: "release-review",
    });
    const model = {
      workflows: [
        {
          workflow,
          phases: [
            {
              index: 0,
              title: "Implementation",
              members: [member],
              state: "running" as const,
              activeCount: 1,
              settledCount: 0,
            },
          ],
          unphasedMembers: [],
        },
      ],
      directAgents: [],
      directAgentGroups: [],
      runningCount: 1,
      waitingCount: 0,
      idleCount: 0,
      settledCount: 0,
      totalTokens: 1200,
      hasAgents: true,
      liveCount: 1,
    };

    const html = renderToStaticMarkup(
      <AgentsRoster
        model={model}
        selectedAgentId={null}
        selectedWorkflowId={workflow.id}
        autoFocusTargetId={null}
        onSelectAgent={() => undefined}
        onSelectWorkflow={() => undefined}
      />,
    );

    expect(html.match(/data-workflow-run-id=/g)).toHaveLength(1);
    expect(html).toContain("release-review");
    expect(html).not.toContain("Nested implementation agent");
    expect(html).not.toContain("Implementation");
  });
});

describe("WorkflowDetail", () => {
  it("renders expandable phases and selectable nested agents in the detail pane", () => {
    const member = makeAgent({
      id: "agent-phase",
      title: "Phase reviewer",
      kind: "workflow_agent",
      parentAgentId: "workflow-1",
      phaseIndex: 0,
      phaseTitle: "Audit",
      workflowName: "release-review",
    });
    const secondMember = makeAgent({
      id: "agent-phase-2",
      title: "Independent reviewer",
      kind: "workflow_agent",
      parentAgentId: "workflow-1",
      phaseIndex: 0,
      phaseTitle: "Audit",
      workflowName: "release-review",
      model: "opencode-go/kimi-k3",
      effort: "medium",
    });
    const group: AgentPanelWorkflowGroup = {
      workflow: makeAgent({
        id: "workflow-1",
        title: "Release review",
        kind: "workflow",
        workflowName: "release-review",
      }),
      phases: [
        {
          index: 0,
          title: "Audit",
          members: [member, secondMember],
          state: "running",
          activeCount: 2,
          settledCount: 0,
        },
      ],
      unphasedMembers: [],
    };

    const html = renderToStaticMarkup(
      <WorkflowDetail group={group} selectedAgentId={null} onSelectAgent={() => undefined} />,
    );

    expect(html).toContain("Workflow");
    expect(html).toContain("release-review");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Audit");
    expect(html).toContain("Phase reviewer");
    expect(html).toContain("Independent reviewer");
    expect(html).toContain("openai-codex/gpt-5.6-sol · high");
    expect(html).toContain("opencode-go/kimi-k3 · medium");
    expect(html).toContain('aria-label="release-review workflow map"');
  });
});
