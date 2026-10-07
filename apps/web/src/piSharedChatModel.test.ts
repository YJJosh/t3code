import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  modelSelectionKey,
  piModelSelectionToFollow,
  readPiThreadModelSeen,
  writePiThreadModelSeen,
} from "./piSharedChatModel";

const PI = ProviderInstanceId.make("pi");
const sol: ModelSelection = { instanceId: PI, model: "openai-codex/gpt-5.6-sol" };
const terra: ModelSelection = { instanceId: PI, model: "openai-codex/gpt-5.6-terra" };

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("piModelSelectionToFollow", () => {
  it("follows a model change made outside the composer", () => {
    const result = piModelSelectionToFollow({
      threadModel: terra,
      draftPick: sol,
      lastSeen: modelSelectionKey(sol),
    });
    expect(result).toEqual({ follow: terra, seen: modelSelectionKey(terra) });
  });

  it("keeps a pick made after the composer last saw the thread model", () => {
    const result = piModelSelectionToFollow({
      threadModel: sol,
      draftPick: terra,
      lastSeen: modelSelectionKey(sol),
    });
    expect(result.follow).toBeNull();
  });

  it("does nothing when the pick already matches or there is no pick", () => {
    expect(
      piModelSelectionToFollow({ threadModel: terra, draftPick: terra, lastSeen: undefined })
        .follow,
    ).toBeNull();
    expect(
      piModelSelectionToFollow({ threadModel: terra, draftPick: undefined, lastSeen: "x" }).follow,
    ).toBeNull();
  });

  it("aligns an older pick the first time the thread is seen", () => {
    expect(
      piModelSelectionToFollow({ threadModel: terra, draftPick: sol, lastSeen: undefined }).follow,
    ).toEqual(terra);
  });
});

describe("Pi thread model memory", () => {
  it("survives through storage and keeps a bounded record", () => {
    const storage = createStorageStub();
    writePiThreadModelSeen("env:thread-a", "seen-a", () => storage);
    expect(readPiThreadModelSeen("env:thread-a", () => storage)).toBe("seen-a");
    expect(JSON.parse(storage.getItem("t3code:pi-thread-model-seen") ?? "{}")).toEqual({
      "env:thread-a": "seen-a",
    });
    for (let index = 0; index < 250; index += 1) {
      writePiThreadModelSeen(`env:t${index}`, "s", () => storage);
    }
    const record = JSON.parse(storage.getItem("t3code:pi-thread-model-seen") ?? "{}");
    expect(Object.keys(record).length).toBe(200);
    expect(record["env:t249"]).toBe("s");
  });

  it("still remembers when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    writePiThreadModelSeen("env:thread-b", "seen-b", blocked);
    expect(readPiThreadModelSeen("env:thread-b", blocked)).toBe("seen-b");
  });
});
