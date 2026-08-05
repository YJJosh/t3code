import { describe, expect, it } from "vite-plus/test";

import { canAutoStartIndexDraft } from "./indexDraftLanding";

describe("canAutoStartIndexDraft", () => {
  it("waits for primary server settings after environment shells bootstrap", () => {
    expect(
      canAutoStartIndexDraft({
        shellsBootstrapped: true,
        primaryServerConfigReady: false,
      }),
    ).toBe(false);
  });

  it("starts only after both shell and server config state are ready", () => {
    expect(
      canAutoStartIndexDraft({
        shellsBootstrapped: false,
        primaryServerConfigReady: true,
      }),
    ).toBe(false);
    expect(
      canAutoStartIndexDraft({
        shellsBootstrapped: true,
        primaryServerConfigReady: true,
      }),
    ).toBe(true);
  });
});
