import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { threadAttentionKey } from "./ThreadNotificationCoordinator.logic";

// REVIEW: a fast second approval can replace the first before React renders the gap.
it.each(["input", "approval"])(
  "distinguishes %s requests in one run without repeating snapshot alerts",
  (status) => {
    const thread = {
      latestRunId: RunId.make("one-run"),
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("first"),
        kind: "user_input" as const,
        createdAt: DateTime.makeUnsafe(0),
      },
    };
    const first = threadAttentionKey(thread, status);
    expect(threadAttentionKey({ ...thread }, status)).toBe(first);
    expect(
      threadAttentionKey(
        {
          ...thread,
          pendingRuntimeRequest: {
            ...thread.pendingRuntimeRequest,
            id: RuntimeRequestId.make("second"),
          },
        },
        status,
      ),
    ).not.toBe(first);
    expect(threadAttentionKey(thread, "working")).toBeNull();
  },
);
