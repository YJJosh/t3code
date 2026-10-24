import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  toolCallLines,
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "./itemDetail.ts";

function toolItem(output: unknown): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("images"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName: "screenshots",
    input: {},
    output,
  };
}

const dynamicTool = {
  id: TurnItemId.make("tool"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "tool",
  input: {},
  output: undefined,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
};

describe("tool image output parsing", () => {
  it.each(["array", "content"] as const)(
    "keeps markers for images beyond the served positions in %s output",
    (shape) => {
      // Detail responses retain image metadata after the server strips image bytes.
      const image = { type: "image", mimeType: "image/png" };
      const blocks = Array.from({ length: 8 }, () => ({ ...image }));
      const wrap = (content: unknown[]) => (shape === "array" ? content : { content });
      const withinLimit = toolItem(wrap(blocks));
      expect(turnItemOutputText(withinLimit)).toBeNull();
      expect(turnItemOutputImages(withinLimit)).toHaveLength(8);

      const overflow = toolItem(
        wrap([
          ...blocks,
          { type: "text", text: "Two additional screenshots:" },
          { ...image, sizeBytes: 100 },
          { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
        ]),
      );
      expect(turnItemOutputImages(overflow)).toHaveLength(8);
      expect(turnItemOutputText(overflow)).toBe("Two additional screenshots:\n[image]\n[image]");
    },
  );
});

it("keeps html_show title-only without fetching the HTML or terminal copy", () => {
  for (const input of [
    { title: "Results", html: "<h1>Results</h1>", text: "Terminal copy" },
    { title: "Results", path: "/tmp/page.html", text: "Terminal copy" },
    { summary: "<h1>Results</h1>", truncated: true },
  ]) {
    const item = {
      ...dynamicTool,
      toolName: "html_show",
      title: "Results",
      input,
      outputOmitted: true,
    };
    expect(turnItemHasDetail(item)).toBe(false);
    expect(turnItemNeedsDetailFetch(item)).toBe(false);
    expect(turnItemHasDetail({ ...item, toolName: "other_tool" })).toBe(true);
    expect(turnItemNeedsDetailFetch({ ...item, toolName: "other_tool" })).toBe(true);
  }
});

it("keeps html_show failure output inspectable without exposing source arguments", () => {
  const item = {
    ...dynamicTool,
    toolName: "html_show",
    status: "failed" as const,
    input: { title: "Results", html: "<h1>Results</h1>", text: "Terminal copy" },
    output: { content: [{ type: "text", text: "Source file does not exist." }] },
  };
  const withheld = { ...item, output: undefined, outputOmitted: true };
  expect(turnItemHasDetail(withheld)).toBe(true);
  expect(turnItemNeedsDetailFetch(withheld)).toBe(true);
  expect(turnItemHasDetail(item)).toBe(true);
  expect(turnItemOutputText(item)).toBe("Source file does not exist.");
  expect(toolCallLines({ toolName: item.toolName, args: item.input })).toEqual({
    command: null,
    args: null,
    argsText: null,
  });
  expect(toolCallLines({ args: item.input }).args).not.toBeNull();
});
