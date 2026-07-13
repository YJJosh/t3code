import { describe, expect, it } from "@effect/vitest";

import { parsePiProfileChoices } from "./piProfileDiscovery.ts";

describe("parsePiProfileChoices", () => {
  it("returns configured profiles with descriptions and marks the configured default", () => {
    expect(
      parsePiProfileChoices(
        {
          profiles: {
            research: { description: "Read-only research" },
            coder: { description: "Full coding tools" },
          },
        },
        "coder",
      ),
    ).toEqual([
      { id: "coder", label: "coder", description: "Full coding tools", isDefault: true },
      { id: "research", label: "research", description: "Read-only research" },
    ]);
  });

  it("supports legacy files that define profiles as top-level keys", () => {
    expect(
      parsePiProfileChoices(
        {
          default: "coder",
          coder: { model: "gpt-5.6-sol", description: "Full coding tools" },
          research: { disabledTools: ["edit", "write"], description: "Read-only research" },
          metadata: { description: "Not a profile" },
        },
        "coder",
      ),
    ).toEqual([
      { id: "coder", label: "coder", description: "Full coding tools", isDefault: true },
      { id: "research", label: "research", description: "Read-only research" },
    ]);
  });

  it("keeps the configured profile available when the file is missing or does not define it", () => {
    expect(parsePiProfileChoices(undefined, "reviewer")).toEqual([
      { id: "reviewer", label: "reviewer", isDefault: true },
    ]);
  });
});
