import { EnvironmentId, ProfilesError, type ProfilesSyncState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import {
  classifyProfilesSyncFailure,
  pickProfilesSyncWinner,
  planProfilesSync,
  type ProfilesSyncAnswer,
  type ProfilesSyncIo,
  runProfilesSync,
} from "./profilesSync.ts";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const C = EnvironmentId.make("env-c");

const state = (
  revision: number,
  hash: string,
  extra: Partial<ProfilesSyncState> = {},
): ProfilesSyncState => ({
  revision,
  hash,
  syncedHash: hash,
  updatedAt: null,
  ...extra,
});

const ok = <A>(value: A): ProfilesSyncAnswer<A> => ({ ok: true, value });

function fakeIo(initial: Record<string, ProfilesSyncState | "unsupported">) {
  const states = new Map(Object.entries(initial));
  const calls: string[] = [];
  const conflictOnce = new Set<string>();
  const io: ProfilesSyncIo = {
    read: async (environmentId, includeFiles) => {
      calls.push(`read:${environmentId}:${includeFiles}`);
      const current = states.get(environmentId)!;
      if (current === "unsupported") return { ok: false, failure: { kind: "unsupported" } };
      return ok(
        includeFiles
          ? { state: current, files: [{ path: "profiles.json", contentBase64: "e30=" }] }
          : { state: current },
      );
    },
    write: async (environmentId, input) => {
      calls.push(`write:${environmentId}:${input.expectedRevision}:${input.source.hash}`);
      if (conflictOnce.delete(environmentId)) {
        const current = states.get(environmentId) as ProfilesSyncState;
        states.set(environmentId, { ...current, revision: current.revision + 1 });
        return { ok: false, failure: { kind: "conflict", message: "changed" } };
      }
      const current = states.get(environmentId) as ProfilesSyncState;
      const next = state(input.source.revision, input.source.hash);
      states.set(environmentId, next);
      const unsynced = current.hash !== current.syncedHash && current.hash !== input.source.hash;
      return ok(unsynced ? { state: next, backupPath: "/backups/1" } : { state: next });
    },
    mark: async (environmentId, hash) => {
      calls.push(`mark:${environmentId}:${hash}`);
      const current = states.get(environmentId) as ProfilesSyncState;
      const next = { ...current, syncedHash: hash };
      states.set(environmentId, next);
      return ok(next);
    },
    now: () => "2026-11-13T12:00:00.000Z",
  };
  return { io, calls, conflictOnce, states };
}

describe("pickProfilesSyncWinner", () => {
  it.each([
    ["the highest revision", [state(2, "x"), state(3, "y"), state(1, "z")], B],
    [
      "the latest change on a revision tie",
      [
        state(3, "x", { updatedAt: "2026-11-13T10:00:00Z" }),
        state(3, "y", { updatedAt: "2026-11-13T11:00:00Z" }),
        state(1, "z"),
      ],
      B,
    ],
    ["the first environment on a full tie", [state(3, "x"), state(3, "y"), state(3, "z")], A],
  ])("picks %s", (_name, states, expected) => {
    const participants = [A, B, C].map((environmentId, index) => ({
      environmentId,
      state: states[index]!,
    }));
    expect(pickProfilesSyncWinner(participants)?.environmentId).toBe(expected);
    expect(pickProfilesSyncWinner([...participants].reverse())?.environmentId).toBe(expected);
  });
});

describe("planProfilesSync", () => {
  it("aligns revisions even when every hash matches", () => {
    const plan = planProfilesSync([
      { environmentId: A, state: state(2, "h") },
      { environmentId: B, state: state(1, "h", { syncedHash: null }) },
    ]);
    expect(plan.kind === "copy" && plan.targets.map(({ environmentId }) => environmentId)).toEqual([
      B,
    ]);
  });

  it("copies the winner only to copies whose hash differs", () => {
    const plan = planProfilesSync([
      { environmentId: A, state: state(4, "new") },
      { environmentId: B, state: state(4, "new") },
      { environmentId: C, state: state(2, "old") },
    ]);
    expect(plan.kind === "copy" && plan.winner.environmentId).toBe(A);
    expect(plan.kind === "copy" && plan.targets.map(({ environmentId }) => environmentId)).toEqual([
      C,
    ]);
  });
});

describe("runProfilesSync", () => {
  it("reads only states when everything is in sync", async () => {
    const { io, calls } = fakeIo({ [A]: state(2, "h"), [B]: state(2, "h") });
    const statuses = await runProfilesSync(io, () => [A, B]);
    expect(calls).toEqual(["read:env-a:false", "read:env-b:false"]);
    expect(statuses.get(B)).toEqual({ kind: "inSync", revision: 2 });
  });

  it("keeps a later edit on a previously identical lower-revision copy", async () => {
    const { io, states } = fakeIo({ [A]: state(5, "same"), [B]: state(1, "same") });
    await runProfilesSync(io, () => [A, B]);
    const synced = states.get(B) as ProfilesSyncState;
    expect(synced.revision).toBe(5);
    states.set(B, { ...synced, revision: synced.revision + 1, hash: "edited" });
    await runProfilesSync(io, () => [A, B]);
    expect((states.get(A) as ProfilesSyncState).hash).toBe("edited");
    expect((states.get(B) as ProfilesSyncState).hash).toBe("edited");
  });

  it("copies the winner's files once, reports backups, and marks the winner", async () => {
    const { io, calls } = fakeIo({
      [A]: state(5, "new", { syncedHash: "old" }),
      [B]: state(3, "old"),
      [C]: state(4, "edited", { syncedHash: "old" }),
    });
    const statuses = await runProfilesSync(io, () => [A, B, C]);
    expect(calls.filter((call) => call.startsWith("read:") && call.endsWith(":true"))).toEqual([
      "read:env-a:true",
    ]);
    expect(calls).toContain("write:env-b:3:new");
    expect(calls).toContain("write:env-c:4:new");
    expect(calls.at(-1)).toBe("mark:env-a:new");
    expect(statuses.get(A)).toEqual({ kind: "inSync", revision: 5 });
    expect(statuses.get(B)).toEqual({
      kind: "updated",
      revision: 5,
      at: "2026-11-13T12:00:00.000Z",
    });
    expect(statuses.get(C)).toEqual({
      kind: "backup",
      revision: 5,
      at: "2026-11-13T12:00:00.000Z",
      path: "/backups/1",
    });
  });

  it("skips servers without profile sync quietly", async () => {
    const { io, calls } = fakeIo({
      [A]: state(2, "new"),
      [B]: "unsupported",
      [C]: state(1, "old"),
    });
    const statuses = await runProfilesSync(io, () => [A, B, C]);
    expect(statuses.get(B)).toEqual({ kind: "unsupported" });
    expect(calls.some((call) => call.startsWith("write:env-b"))).toBe(false);
    expect(statuses.get(C)?.kind).toBe("updated");
  });

  it("re-runs once when a target changed during the copy, and the changed target wins", async () => {
    const { io, calls, conflictOnce } = fakeIo({
      [A]: state(3, "a", { updatedAt: "2026-11-13T10:00:00Z" }),
      [B]: state(3, "b", { updatedAt: "2026-11-13T09:00:00Z" }),
    });
    conflictOnce.add(B);
    const statuses = await runProfilesSync(io, () => [A, B]);
    // B's outside edit bumped it to revision 4, so the second run copies B to A.
    expect(calls).toContain("write:env-b:3:a");
    expect(calls).toContain("write:env-a:3:b");
    expect(calls).not.toContain("mark:env-a:a");
    expect(statuses.get(A)?.kind).toBe("updated");
    expect(statuses.get(B)).toEqual({ kind: "inSync", revision: 4 });
  });
});

describe("classifyProfilesSyncFailure", () => {
  it.each([
    [
      "an unknown method",
      Cause.die("Unknown request tag: profiles.sync.read"),
      { kind: "unsupported" },
    ],
    [
      "a conflict",
      Cause.fail(new ProfilesError({ reason: "conflict", message: "changed" })),
      { kind: "conflict", message: "changed" },
    ],
    [
      "other profile errors",
      Cause.fail(new ProfilesError({ reason: "io", message: "disk full" })),
      { kind: "failed", message: "disk full" },
    ],
  ])("classifies %s", (_name, cause, expected) => {
    expect(classifyProfilesSyncFailure(cause)).toEqual(expected);
  });
});
