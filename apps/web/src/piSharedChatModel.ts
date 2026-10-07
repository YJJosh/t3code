import type { ModelSelection } from "@t3tools/contracts";

// A shared Pi chat (pi-sessions) can switch model in the terminal. The server
// then moves the thread's model, but the composer keeps the user's last pick
// for the thread and would send it back with the next message. The composer
// remembers which thread model it last saw; when the thread's model moves
// away from that, the newer change wins and the composer follows it.
const SEEN_STORAGE_KEY = "t3code:pi-thread-model-seen";
const SEEN_LIMIT = 200;
const seenInMemory = new Map<string, string>();

export function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.instanceId}\u0000${selection.model}`;
}

/**
 * Decides whether the composer should drop its pick for a Pi thread. `seen`
 * is what to remember for next time; `follow` is the selection to adopt.
 */
export function piModelSelectionToFollow(input: {
  readonly threadModel: ModelSelection;
  readonly draftPick: ModelSelection | undefined;
  readonly lastSeen: string | undefined;
}): { readonly follow: ModelSelection | null; readonly seen: string } {
  const seen = modelSelectionKey(input.threadModel);
  if (input.lastSeen === seen) return { follow: null, seen };
  if (input.draftPick === undefined || input.draftPick.model === input.threadModel.model) {
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

export function readPiThreadModelSeen(
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

export function writePiThreadModelSeen(
  threadKey: string,
  seen: string,
  getStorage: () => Storage = () => window.sessionStorage,
): void {
  if (seenInMemory.get(threadKey) === seen) return;
  seenInMemory.set(threadKey, seen);
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
