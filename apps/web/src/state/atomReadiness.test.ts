import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { waitForAtomValue } from "./atomReadiness";

const isString = (value: string | number | null): value is string => typeof value === "string";

describe("waitForAtomValue", () => {
  it("resolves immediately when the current value is ready", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<string | number | null>("ready");

    await expect(waitForAtomValue(registry, atom, isString)).resolves.toBe("ready");
    registry.dispose();
  });

  it("waits through nonmatching updates and resolves when the value becomes ready", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<string | number | null>(null);
    let settled = false;
    const pending = waitForAtomValue(registry, atom, isString).then((value) => {
      settled = true;
      return value;
    });

    registry.set(atom, 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.set(atom, "loaded");
    await expect(pending).resolves.toBe("loaded");
    registry.dispose();
  });
});
