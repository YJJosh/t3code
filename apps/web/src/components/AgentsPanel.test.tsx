// @vitest-environment jsdom

import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: OrchestrationV2ThreadProjection) => {
    await act(() =>
      root.render(<AgentsPanel environmentId={EnvironmentId.make("local")} projection={next} />),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
  };
  try {
    await render(projection());
    expect(container.querySelector("[data-agent-detail]")?.getAttribute("data-agent-detail")).toBe(
      "dulli:subagent:first",
    );
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft reply"]')!;
    draft.value = "Keep this draft";
    await render(projection(true));
    expect(container.querySelector("[data-agent-detail]")?.getAttribute("data-agent-detail")).toBe(
      "dulli:subagent:first",
    );
    expect(container.querySelector('input[aria-label="Draft reply"]')).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.useRealTimers();
  }
});
