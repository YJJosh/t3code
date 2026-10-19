import { useEffect } from "react";
import { useServerConfigs } from "./entities";
import { migrateDulliComposerState } from "./use-composer-drafts";

let pending = Promise.resolve();
export function useDulliClientMigration(): void {
  const configs = useServerConfigs();
  useEffect(() => {
    pending = pending
      .then(async () => {
        for (const [id, config] of configs) await migrateDulliComposerState(id, config);
      })
      .catch((error: unknown) => {
        console.warn("Could not migrate Dulli client selections", error);
      });
  }, [configs]);
}
