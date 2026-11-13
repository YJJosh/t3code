import { useAtomValue } from "@effect/atom-react";
import { createProfilesEnvironmentAtoms } from "@t3tools/client-runtime/state/profiles";
import { createProfilesSync } from "@t3tools/client-runtime/state/profiles-sync";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentIdsKey } from "./environmentAtomList";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "./session";
import { useEnvironments } from "./environments";

export const profilesEnvironment = createProfilesEnvironmentAtoms(connectionAtomRuntime, {
  catalog: serverEnvironment.profileConfig,
});
const profilesSync = createProfilesSync(profilesEnvironment);

/** Connected environments this client may write settings on, read when a run starts. */
function readProfilesSyncParticipants(): ReadonlyArray<EnvironmentId> {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return [...presentations.entries()].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase === "connected" &&
    readEnvironmentScope(environmentId, AuthSettingsWriteScope)
      ? [environmentId]
      : [],
  );
}

export function syncProfilesNow(): Promise<void> {
  return profilesSync.request(appAtomRegistry, readProfilesSyncParticipants);
}

export function useProfilesSyncSnapshot() {
  return useAtomValue(profilesSync.snapshotAtom);
}

// Connections often come up together at launch; one run covers them all.
const CONNECT_DEBOUNCE_MS = 1_500;

/** Mounted once: copies profiles after a change made here and when an environment connects. */
export function ProfilesSyncHost() {
  const { environments } = useEnvironments();
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const writable = useEnvironmentsWithScope(connected, AuthSettingsWriteScope);
  const participantsKey = environmentIdsKey(
    connected.flatMap(({ environmentId }) => (writable.has(environmentId) ? [environmentId] : [])),
  );
  const localChange = useAtomValue(profilesEnvironment.localChangeAtom).count;
  const seen = useRef(new Set<string>());
  const sync = useEffectEvent(() => void syncProfilesNow());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a newly connected environment starts a debounced sync with the others
  useEffect(() => {
    const ids = participantsKey === "" ? [] : participantsKey.split("\n");
    const added = ids.some((id) => !seen.current.has(id));
    seen.current = new Set(ids);
    if (!added || ids.length < 2) return;
    const timer = setTimeout(sync, CONNECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [participantsKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a save or skill command on one environment is copied to the others
  useEffect(() => {
    if (localChange > 0) sync();
  }, [localChange]);

  return null;
}
