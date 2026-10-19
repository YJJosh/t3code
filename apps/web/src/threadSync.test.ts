import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("reports disconnected cached detail honestly", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("disconnected");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it.each(["empty", "cached", "synchronizing", "live"] as const)(
    "exposes a failed %s stream instead of syncing",
    (status) => {
      expect(
        resolveThreadSyncPhase({
          shellExists: true,
          detailExists: true,
          status,
          error: "stream failed",
        }),
      ).toBe("failed");
    },
  );
  it("syncs only during active catch-up", () => {
    expect(
      resolveThreadSyncPhase({ shellExists: true, detailExists: true, status: "synchronizing" }),
    ).toBe("syncing");
    expect(
      resolveThreadSyncPhase({ shellExists: true, detailExists: false, status: "empty" }),
    ).toBe("disconnected");
  });
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
    expect(threadSyncLabel("disconnected")).toBe("Messages disconnected");
    expect(threadSyncLabel("failed")).toBe("Message sync failed");
  });
});
