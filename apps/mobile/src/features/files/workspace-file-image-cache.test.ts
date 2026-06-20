import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkspaceFileImageAtomFamily,
  isWorkspaceImagePrefetchError,
} from "./workspace-file-image-cache";

describe("workspaceFileImageAtom", () => {
  it("reuses a prefetched image across route remounts", async () => {
    const prefetch = vi.fn(async () => true);
    const imageAtom = createWorkspaceFileImageAtomFamily({ idleTtlMs: 1_000, prefetch });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const first = imageAtom("https://example.test/image.png");
    const firstUnmount = registry.mount(first);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(first))).toBe(true);
    });
    firstUnmount();

    const remounted = imageAtom("https://example.test/image.png");
    const secondUnmount = registry.mount(remounted);

    expect(remounted).toBe(first);
    expect(AsyncResult.isSuccess(registry.get(remounted))).toBe(true);
    expect(prefetch).toHaveBeenCalledTimes(1);

    secondUnmount();
    registry.dispose();
  });

  it("prefetches different asset URLs independently", async () => {
    const prefetch = vi.fn(async () => true);
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch });
    const registry = AtomRegistry.make();
    const first = imageAtom("https://example.test/first.png");
    const second = imageAtom("https://example.test/second.png");
    const firstUnmount = registry.mount(first);
    const secondUnmount = registry.mount(second);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(first))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(second))).toBe(true);
    });
    expect(prefetch).toHaveBeenCalledTimes(2);

    firstUnmount();
    secondUnmount();
    registry.dispose();
  });

  it("exposes a false native prefetch result", async () => {
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch: async () => false });
    const registry = AtomRegistry.make();
    const atom = imageAtom("https://example.test/missing.png");
    const unmount = registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    const error = AsyncResult.isFailure(result)
      ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
      : undefined;

    expect(isWorkspaceImagePrefetchError(error)).toBe(true);
    expect(error).toMatchObject({ uri: "https://example.test/missing.png" });
    expect(error).not.toHaveProperty("cause");

    unmount();
    registry.dispose();
  });

  it("preserves thrown prefetch causes", async () => {
    const cause = new Error("native image prefetch failed");
    const imageAtom = createWorkspaceFileImageAtomFamily({
      prefetch: async () => {
        throw cause;
      },
    });
    const registry = AtomRegistry.make();
    const atom = imageAtom("https://example.test/missing.png");
    const unmount = registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    const error = AsyncResult.isFailure(result)
      ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
      : undefined;

    expect(isWorkspaceImagePrefetchError(error)).toBe(true);
    expect(error).toMatchObject({
      uri: "https://example.test/missing.png",
      cause,
    });

    unmount();
    registry.dispose();
  });
});
