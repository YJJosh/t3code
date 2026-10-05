import { AgentSessionImportResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as PiSessionsSync from "../../project/PiSessionsSync.ts";

export const PiSessionsToolkit = Toolkit.make(
  Tool.make("refresh_pi_sessions", {
    description:
      "Import stopped Pi sessions from the optional local pi-sessions daemon into existing T3 projects. Does not start the daemon, create projects, or refresh already imported history.",
    success: AgentSessionImportResult,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

export const handlersLayer = PiSessionsToolkit.toLayer(
  Effect.gen(function* () {
    const sync = yield* PiSessionsSync.PiSessionsSync;
    return { refresh_pi_sessions: () => sync.refresh };
  }),
);
