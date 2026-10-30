import type { ModelSelection } from "@t3tools/contracts";

// A shared Pi terminal can change the thread model outside this client. Follow only
// changes since the last seen thread model so stale composer picks cannot undo them.
const SEEN_STORAGE_KEY = "t3code:dulli-thread-model-seen";
const SEEN_LIMIT = 200;
const seenInMemory = new Map<string, string>();

export function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.instanceId}\u0000${selection.model}\u0000${selection.options?.find((option) => option.id === "reasoning")?.value ?? ""}`;
}

/**
 * Decides whether the composer should drop its pick for a Dulli thread. `seen`
 * is what to remember for next time; `follow` is the selection to adopt.
 */
export function dulliModelSelectionToFollow(input: {
  readonly threadModel: ModelSelection;
  readonly draftPick: ModelSelection | undefined;
  readonly lastSeen: string | undefined;
}): { readonly follow: ModelSelection | null; readonly seen: string } {
  const seen = modelSelectionKey(input.threadModel);
  if (input.lastSeen === seen) return { follow: null, seen };
  if (input.draftPick === undefined || modelSelectionKey(input.draftPick) === seen) {
    return { follow: null, seen };
  }
  return { follow: input.threadModel, seen };
}

function readSeen(storage: Storage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SEEN_STORAGE_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readDulliThreadModelSeen(
  threadKey: string,
  getStorage: () => Storage = () => window.sessionStorage,
): string | undefined {
  const inMemory = seenInMemory.get(threadKey);
  if (inMemory !== undefined) return inMemory;
  try {
    const value = readSeen(getStorage())[threadKey];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeDulliThreadModelSeen(
  threadKey: string,
  seen: string,
  getStorage: () => Storage = () => window.sessionStorage,
): void {
  if (seenInMemory.get(threadKey) === seen) return;
  seenInMemory.set(threadKey, seen);
  if (seenInMemory.size > SEEN_LIMIT) seenInMemory.delete(seenInMemory.keys().next().value!);
  try {
    const storage = getStorage();
    const record = readSeen(storage);
    if (record[threadKey] === seen) return;
    delete record[threadKey];
    record[threadKey] = seen;
    const keys = Object.keys(record);
    for (const key of keys.slice(0, Math.max(0, keys.length - SEEN_LIMIT))) delete record[key];
    storage.setItem(SEEN_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Without storage the composer only follows changes it sees while open.
  }
}
