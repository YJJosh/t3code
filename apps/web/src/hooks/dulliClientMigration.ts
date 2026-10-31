import { isDulliCutover } from "@t3tools/client-runtime/dulli-migration";
import { environmentServerConfigsAtom } from "../state/server";
import { migrateDulliComposerState } from "../composerDraftStore";
import type { AtomRegistry } from "effect/reactivity";

const KEY = "t3code:dulli-client-identity-v1";
let pending = Promise.resolve();

/** Receipt lives beside client data, never on the server: returning to a migrated
 * environment must not rename newly chosen upstream Pi selections. Subscribed
 * outside render, since it only writes browser storage. */
export function startDulliClientMigration(registry: AtomRegistry.AtomRegistry): () => void {
  return registry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      pending = pending
        .then(async () => {
          const checked: Record<string, boolean> = JSON.parse(localStorage.getItem(KEY) ?? "{}");
          for (const [environmentId, config] of configs) {
            if (config.legacyPiProviderMigrated === undefined || environmentId in checked) continue;
            const migrated = isDulliCutover(config);
            const global = !("*" in checked);
            if (migrated) {
              migrateDulliComposerState(environmentId, global);
              if (global) {
                // Only the fork wrote this key. Its model-follow cache is disposable;
                // dropping it is safer than reviving a second source of selection state.
                sessionStorage.removeItem("t3code:pi-thread-model-seen");
              }
            }
            checked[environmentId] = migrated;
            if (global) checked["*"] = migrated;
            localStorage.setItem(KEY, JSON.stringify(checked));
          }
        })
        .catch((error: unknown) => {
          console.warn("Could not migrate Dulli client selections", error);
        });
    },
    { immediate: true },
  );
}
