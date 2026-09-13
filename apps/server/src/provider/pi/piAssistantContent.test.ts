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
      {
        streamKind: "reasoning_text",
        contentIndex: 0,
        delta: "Plan",
        startsBlock: true,
      },
      {
        streamKind: "assistant_text",
        contentIndex: 1,
        delta: "First paragraph.",
        startsBlock: true,
      },
      {
        streamKind: "reasoning_text",
        contentIndex: 2,
        delta: "\n\nVerify",
        startsBlock: true,
        blockBoundary: "\n\n",
      },
      {
        streamKind: "assistant_text",
        contentIndex: 3,
        delta: "\n\n# Invoice Summary",
        startsBlock: true,
        blockBoundary: "\n\n",
      },
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
        startsBlock: true,
      },
      {
        streamKind: "reasoning_text",
        contentIndex: 2,
        delta: "Verifying",
        startsBlock: true,
      },
    ]);
    expect(state.streams.reasoning_text.content).toBe("**Inspecting**\n\nVerifying");
  });

  it("hydrates indexed blocks from a cumulative snapshot before later deltas", () => {
    const hydrated = applyPiAssistantSnapshot(makePiAssistantContentState(), {
      assistant_text: "Legacy",
      reasoning_text: "",
      blocks: [{ streamKind: "assistant_text", contentIndex: 0, content: "Legacy" }],
    });
    expect(hydrated.deltas).toEqual([
      {
        streamKind: "assistant_text",
        contentIndex: 0,
        delta: "Legacy",
        startsBlock: true,
      },
    ]);

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

  it("keeps snapshot-only blocks in native order with distinct boundaries", () => {
    const result = applyPiAssistantSnapshot(makePiAssistantContentState(), {
      assistant_text: "Narration\n\n# Final",
      reasoning_text: "Plan",
      blocks: [
        { streamKind: "reasoning_text", contentIndex: 0, content: "Plan" },
        { streamKind: "assistant_text", contentIndex: 1, content: "Narration" },
        { streamKind: "assistant_text", contentIndex: 2, content: "# Final" },
      ],
    });

    expect(result.deltas).toEqual([
      {
        streamKind: "reasoning_text",
        contentIndex: 0,
        delta: "Plan",
        startsBlock: true,
      },
      {
        streamKind: "assistant_text",
        contentIndex: 1,
        delta: "Narration",
        startsBlock: true,
      },
      {
        streamKind: "assistant_text",
        contentIndex: 2,
        delta: "\n\n# Final",
        startsBlock: true,
        blockBoundary: "\n\n",
      },
    ]);
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
      { streamKind: "assistant_text", delta: "First", startsBlock: true },
      {
        streamKind: "assistant_text",
        delta: "\n\n# Second",
        startsBlock: true,
        blockBoundary: "\n\n",
      },
    ]);
    expect(state.streams.assistant_text.content).toBe("First\n\n# Second");
  });

  it("does not replay legacy text when indexed streaming resumes after a snapshot", () => {
    const streamed = applyEvents([
      { type: "text_start" },
      { type: "text_delta", delta: "First" },
      { type: "text_end", content: "First" },
      { type: "text_start" },
      { type: "text_delta", delta: "# Second" },
    ]);
    const result = applyPiAssistantSnapshot(streamed.state, {
      assistant_text: "First\n\n# Second",
      reasoning_text: "",
      blocks: [
        { streamKind: "assistant_text", contentIndex: 0, content: "First" },
        { streamKind: "assistant_text", contentIndex: 1, content: "# Second" },
      ],
    });
    expect(result.deltas).toEqual([]);
    expect(result.state.streams.assistant_text.content).toBe("First\n\n# Second");
    const resumed = applyPiAssistantBlockEvent(result.state, {
      type: "text_end",
      contentIndex: 1,
      content: "# Second expanded",
    });
    expect(resumed.deltas).toEqual([
      { streamKind: "assistant_text", contentIndex: 1, delta: " expanded" },
    ]);
    expect(resumed.state.streams.assistant_text.content).toBe("First\n\n# Second expanded");
  });

  it("rejects indexed snapshots that revise earlier blocks instead of extending the stream", () => {
    const streamed = applyEvents([
      { type: "text_delta", contentIndex: 0, delta: "First" },
      { type: "text_delta", contentIndex: 1, delta: "Second" },
    ]);
    const result = applyPiAssistantSnapshot(streamed.state, {
      assistant_text: "First revised\n\nSecond",
      reasoning_text: "",
      blocks: [
        { streamKind: "assistant_text", contentIndex: 0, content: "First revised" },
        { streamKind: "assistant_text", contentIndex: 1, content: "Second" },
      ],
    });
    expect(result.deltas).toEqual([]);
    expect(result.state.streams.assistant_text.content).toBe("First\n\nSecond");
  });

  it("does not replay block endings or authoritative snapshots", () => {
    const streamed = applyEvents([
      { type: "text_delta", contentIndex: 0, delta: "Live" },
      { type: "text_end", contentIndex: 0, content: "Live heading" },
      { type: "text_end", contentIndex: 0, content: "Live heading" },
    ]);
    expect(streamed.deltas).toEqual([
      {
        streamKind: "assistant_text",
        contentIndex: 0,
        delta: "Live",
        startsBlock: true,
      },
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
      {
        streamKind: "assistant_text",
        contentIndex: 0,
        delta: "abcdef",
        startsBlock: true,
      },
    ]);
    expect(streamed.state.streams.assistant_text.content).toBe("abcdef");
  });
});
