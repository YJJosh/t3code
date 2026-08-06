import { describe, expect, it } from "vite-plus/test";

import chatViewSource from "./ChatView.tsx?raw";

describe("ChatView runtime panels", () => {
  it("mounts Pi activity panels alongside the thread sync status", () => {
    const threadSyncStatusIndex = chatViewSource.indexOf("<ThreadSyncStatusPill");
    const backgroundTerminalsIndex = chatViewSource.indexOf("<BackgroundTerminalRuns");
    const subagentsIndex = chatViewSource.indexOf("<SubagentRuns");

    expect(backgroundTerminalsIndex).toBeGreaterThan(-1);
    expect(subagentsIndex).toBeGreaterThan(backgroundTerminalsIndex);
    expect(threadSyncStatusIndex).toBeGreaterThan(subagentsIndex);
  });
});
