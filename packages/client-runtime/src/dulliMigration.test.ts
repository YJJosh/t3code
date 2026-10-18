import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  isDulliCutover,
  migrateForkPiMap,
  migrateForkPiSelection,
  migrateForkPiSelections,
} from "./dulliMigration.ts";

const pi = ProviderInstanceId.make("pi");
const dulli = ProviderInstanceId.make("dulli");
const providers = [{ instanceId: dulli, driver: ProviderDriverKind.make("dulli") }];

describe("fork client identity cutover", () => {
  it("requires explicit server migration evidence, not merely Dulli installation or missing Pi", () => {
    expect(isDulliCutover({ providers })).toBe(false);
    expect(isDulliCutover({ providers, legacyPiProviderMigrated: false })).toBe(false);
    expect(isDulliCutover({ providers: [], legacyPiProviderMigrated: true })).toBe(false);
    expect(isDulliCutover({ providers, legacyPiProviderMigrated: true })).toBe(true);
  });
  it("preserves model slugs, native option strings and custom instance identity", () => {
    const selection = {
      instanceId: pi,
      model: "pi/model",
      options: [
        { id: "profile", value: "pi" },
        { id: "configSet", value: "/home/pi" },
      ],
    };
    expect(migrateForkPiSelection(selection)).toEqual({ ...selection, instanceId: dulli });
    const custom = { ...selection, instanceId: ProviderInstanceId.make("personal") };
    expect(migrateForkPiSelection(custom)).toBe(custom);
    expect(migrateForkPiSelection(null)).toBeNull();
  });
  it("moves per-model sticky options and selection map keys without overwriting Dulli choices", () => {
    expect(migrateForkPiMap({ [pi]: { model: [{ id: "reasoning", value: "high" }] } })).toEqual({
      [dulli]: { model: [{ id: "reasoning", value: "high" }] },
    });
    const selected = {
      [pi]: { instanceId: pi, model: "old" },
      [dulli]: { instanceId: dulli, model: "new" },
    };
    expect(migrateForkPiSelections(selected)).toEqual({ [dulli]: selected[dulli] });
  });
});
