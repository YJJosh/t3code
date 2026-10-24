import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { render } from "../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

// Exercise panel selection across live updates; transcript RPC/rendering is independent.
vi.mock("./agents/AgentDetail", () => ({
  AgentDetail: ({ agent }: { agent: { id: string; title: string } }) => (
    <section data-agent-detail={agent.id}>
      {agent.title}
      <input aria-label="Draft reply" />
    </section>
  ),
}));
vi.mock("~/lib/observeResize", () => ({
  observeResize: (_root: Element, callback: (entries: unknown[]) => void) => {
    callback([{ contentRect: { width: 700 } }]);
    return () => {};
  },
}));

import { AgentsPanel } from "./AgentsPanel";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const instanceId = ProviderInstanceId.make("dulli");
const threadId = ThreadId.make("thread");
function projection(waiting = false): OrchestrationV2ThreadProjection {
  // Only the fields consumed by the inspector are needed for this selection test.
  return {
    thread: { id: threadId },
    messages: [],
    providerSessions: [{ providerInstanceId: instanceId, status: "running", updatedAt: now }],
    dulliRuns: ["first", "second"].map((id) => ({
      id: NodeId.make(`dulli:subagent:${id}`),
      threadId,
      runId: null,
      parentNodeId: NodeId.make("root"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("dulli"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: { driver: ProviderDriverKind.make("dulli"), nativeId: id, strength: "strong" },
      prompt: id,
      title: id,
      model: null,
      status: waiting && id === "second" ? "waiting" : "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
}

it("keeps the automatically opened agent and its draft when another agent needs input", async () => {
  await using screen = await render(
    <AgentsPanel environmentId={EnvironmentId.make("local")} projection={projection()} />,
  );
  const detail = screen.container.querySelector("[data-agent-detail]");
  expect(detail?.getAttribute("data-agent-detail")).toBe("dulli:subagent:first");
  const draft = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Draft reply"]',
  )!;
  await userEvent.fill(screen.getByRole("textbox", { name: "Draft reply" }), "Keep this draft");
  await screen.rerender(
    <AgentsPanel environmentId={EnvironmentId.make("local")} projection={projection(true)} />,
  );
  expect(screen.container.querySelector("[data-agent-detail]")).toBe(detail);
  expect(screen.container.querySelector('input[aria-label="Draft reply"]')).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
});
