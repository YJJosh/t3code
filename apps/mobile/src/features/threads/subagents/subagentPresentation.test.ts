import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSubagentDuration,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
} from "./subagentPresentation";

describe("mobile agent presentation", () => {
  it("distinguishes waiting and settled task states", () => {
    expect(subagentStatusLabel("waiting")).toBe("Needs input");
    expect(subagentStatusTone("waiting")).toBe("warning");
    expect(subagentStatusLabel("completed")).toBe("Completed");
    expect(subagentStatusTone("completed")).toBe("success");
    expect(subagentStatusLabel("interrupted")).toBe("Stopped");
    expect(subagentStatusTone("interrupted")).toBe("muted");
  });

  it("uses the task id when a provider supplies a blank title", () => {
    expect(subagentRunTitle({ id: "run-1", title: "  " } as RuntimeSubagent)).toBe("run-1");
  });

  it("formats settled durations", () => {
    expect(formatSubagentDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:05.000Z")).toBe(
      "1m 5s",
    );
    expect(formatSubagentDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:09.000Z")).toBe(
      "9s",
    );
  });
});
