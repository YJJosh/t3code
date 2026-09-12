import { describe, expect, it } from "@effect/vitest";

import {
  applyPiAssistantBlockEvent,
  applyPiAssistantSnapshot,
  makePiAssistantContentState,
  type PiAssistantBlockEvent,
  type PiAssistantContentDelta,
  type PiAssistantContentState,
} from "./piAssistantContent.ts";

function applyEvents(events: ReadonlyArray<PiAssistantBlockEvent>) {
  let state = makePiAssistantContentState();
  const deltas: PiAssistantContentDelta[] = [];
  for (const event of events) {
    const result = applyPiAssistantBlockEvent(state, event);
    state = result.state;
    deltas.push(...result.deltas);
  }
  return { state, deltas };
}

function snapshot(state: PiAssistantContentState, assistantText: string, reasoningText = "") {
  return applyPiAssistantSnapshot(state, {
    assistant_text: assistantText,
    reasoning_text: reasoningText,
  });
}

describe("Pi assistant content", () => {
  it("assembles interleaved indexed blocks with per-stream boundaries", () => {
    const { state, deltas } = applyEvents([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "Plan" },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "First paragraph." },
      { type: "thinking_start", contentIndex: 2 },
      { type: "thinking_delta", contentIndex: 2, delta: "Verify" },
      { type: "text_start", contentIndex: 3 },
      { type: "text_delta", contentIndex: 3, delta: "# Invoice Summary" },
    ]);

    expect(deltas).toEqual([
      { streamKind: "reasoning_text", contentIndex: 0, delta: "Plan" },
      { streamKind: "assistant_text", contentIndex: 1, delta: "First paragraph." },
      { streamKind: "reasoning_text", contentIndex: 2, delta: "\n\nVerify" },
      { streamKind: "assistant_text", contentIndex: 3, delta: "\n\n# Invoice Summary" },
    ]);
    expect(state.streams.reasoning_text.content).toBe("Plan\n\nVerify");
    expect(state.streams.assistant_text.content).toBe("First paragraph.\n\n# Invoice Summary");
  });

  it("keeps a streamed trailing boundary when block-end content is trimmed", () => {
    const { state, deltas } = applyEvents([
      { type: "thinking_delta", contentIndex: 0, delta: "**Inspecting**\n\n" },
      { type: "thinking_end", contentIndex: 0, content: "**Inspecting**" },
      { type: "thinking_start", contentIndex: 2 },
      { type: "thinking_delta", contentIndex: 2, delta: "Verifying" },
    ]);

    expect(deltas).toEqual([
      {
        streamKind: "reasoning_text",
        contentIndex: 0,
        delta: "**Inspecting**\n\n",
      },
      { streamKind: "reasoning_text", contentIndex: 2, delta: "Verifying" },
    ]);
    expect(state.streams.reasoning_text.content).toBe("**Inspecting**\n\nVerifying");
  });

  it("hydrates indexed blocks from a cumulative snapshot before later deltas", () => {
    const hydrated = applyPiAssistantSnapshot(makePiAssistantContentState(), {
      assistant_text: "Legacy",
      reasoning_text: "",
      blocks: [{ streamKind: "assistant_text", contentIndex: 0, content: "Legacy" }],
    });
    expect(hydrated.deltas).toEqual([{ streamKind: "assistant_text", delta: "Legacy" }]);

    const continued = applyPiAssistantBlockEvent(hydrated.state, {
      type: "text_delta",
      contentIndex: 0,
      delta: " extension",
    });
    expect(continued.deltas).toEqual([
      { streamKind: "assistant_text", contentIndex: 0, delta: " extension" },
    ]);
    expect(continued.state.streams.assistant_text.content).toBe("Legacy extension");
  });

  it("starts a new unindexed block after the previous legacy block ends", () => {
    const { state, deltas } = applyEvents([
      { type: "text_start" },
      { type: "text_delta", delta: "First" },
      { type: "text_end", content: "First" },
      { type: "text_start" },
      { type: "text_delta", delta: "# Second" },
    ]);
    expect(deltas).toEqual([
      { streamKind: "assistant_text", delta: "First" },
      { streamKind: "assistant_text", delta: "\n\n# Second" },
    ]);
    expect(state.streams.assistant_text.content).toBe("First\n\n# Second");
  });

  it("does not replay block endings or authoritative snapshots", () => {
    const streamed = applyEvents([
      { type: "text_delta", contentIndex: 0, delta: "Live" },
      { type: "text_end", contentIndex: 0, content: "Live heading" },
      { type: "text_end", contentIndex: 0, content: "Live heading" },
    ]);
    expect(streamed.deltas).toEqual([
      { streamKind: "assistant_text", contentIndex: 0, delta: "Live" },
      { streamKind: "assistant_text", contentIndex: 0, delta: " heading" },
    ]);
    expect(snapshot(streamed.state, "Live heading").deltas).toEqual([]);
  });

  it("appends only exact prefix extensions from authoritative contents", () => {
    const streamed = applyEvents([{ type: "text_delta", contentIndex: 0, delta: "prefix" }]);

    expect(snapshot(streamed.state, "prefix plus").deltas).toEqual([
      { streamKind: "assistant_text", delta: " plus" },
    ]);
    expect(snapshot(streamed.state, "pref").deltas).toEqual([]);
    expect(snapshot(streamed.state, "PREFIX").deltas).toEqual([]);
    expect(snapshot(streamed.state, "preFIX plus").deltas).toEqual([]);
  });

  it("ignores non-prefix block-end corrections instead of appending an arbitrary tail", () => {
    const streamed = applyEvents([
      { type: "text_delta", contentIndex: 0, delta: "abcdef" },
      { type: "text_end", contentIndex: 0, content: "abcXYZ-tail" },
    ]);
    expect(streamed.deltas).toEqual([
      { streamKind: "assistant_text", contentIndex: 0, delta: "abcdef" },
    ]);
    expect(streamed.state.streams.assistant_text.content).toBe("abcdef");
  });
});
