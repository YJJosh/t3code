import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { migrateDulliComposerState } from "./use-composer-drafts";

export function installDulliClientMigration(): () => void {
  let pending = Promise.resolve();
  return appAtomRegistry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      pending = pending
        .then(async () => {
          for (const [id, config] of configs) await migrateDulliComposerState(id, config);
        })
        .catch((error: unknown) => {
          console.warn("Could not migrate Dulli client selections", error);
        });
    },
    { immediate: true },
  );
}
