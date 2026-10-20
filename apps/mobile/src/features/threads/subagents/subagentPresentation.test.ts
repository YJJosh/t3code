import { describe, expect, it } from "vite-plus/test";

import {
  formatSubagentDuration,
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

  it("formats settled durations", () => {
    expect(formatSubagentDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:05.000Z")).toBe(
      "1m 5s",
    );
    expect(formatSubagentDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:09.000Z")).toBe(
      "9s",
    );
  });
});
