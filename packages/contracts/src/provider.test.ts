import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ProviderSendTurnInput,
  ProviderTaskControlError,
  ProviderTaskControlInput,
  ProviderUploadFeedbackError,
} from "./provider.ts";

const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderTaskControlInput = Schema.decodeUnknownSync(ProviderTaskControlInput);

describe("ProviderSendTurnInput", () => {
  it.each(["image", "file"])(
    "caps total image bytes for %s attachments without charging videos",
    (type) => {
      const image = {
        type,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      };
      const video = {
        type: "file",
        id: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50 * 1024 * 1024,
      };
      expect(
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), video],
        }).attachments,
      ).toHaveLength(9);
      expect(() =>
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
        }),
      ).toThrow(/80 MiB/);
    },
  );
});

describe("provider task control", () => {
  it("requires action-specific task messages", () => {
    expect(
      decodeProviderTaskControlInput({
        threadId: "thread-1",
        taskId: "task-1",
        action: "reply",
        message: "Focus on lifecycle cleanup",
      }),
    ).toEqual({
      threadId: "thread-1",
      taskId: "task-1",
      action: "reply",
      message: "Focus on lifecycle cleanup",
    });
    expect(() =>
      decodeProviderTaskControlInput({
        threadId: "thread-1",
        taskId: "task-1",
        action: "reply",
      }),
    ).toThrow();
  });

  it("rejects steering in the T3 task-control contract", () => {
    expect(() =>
      decodeProviderTaskControlInput({
        threadId: "thread-1",
        taskId: "task-1",
        action: "steer",
        message: "Continue",
      }),
    ).toThrow();
  });

  it("accepts an optional stop reason", () => {
    expect(
      decodeProviderTaskControlInput({
        threadId: "thread-1",
        taskId: "task-1",
        action: "stop",
      }),
    ).toEqual({ threadId: "thread-1", taskId: "task-1", action: "stop" });
  });

  it("keeps task identity and the original cause in structured failures", () => {
    const cause = new Error("private provider detail");
    const error = new ProviderTaskControlError({
      threadId: ThreadId.make("thread-1"),
      taskId: "task-1",
      cause,
    });

    expect(error.message).toBe("Failed to control task task-1 for thread thread-1.");
    expect(error.cause).toBe(cause);
  });
});

describe("provider feedback", () => {
  it("keeps the failed thread and original cause without exposing upstream text", () => {
    const cause = new Error("provider request secret");
    const error = new ProviderUploadFeedbackError({
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error.threadId).toBe("thread-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Failed to upload feedback for thread thread-1.");
    expect(error.message).not.toContain("provider request secret");
  });
});
