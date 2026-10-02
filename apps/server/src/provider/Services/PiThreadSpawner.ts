import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type { PiBackgroundThreadRequest } from "../pi/piRpcProtocol.ts";

/** Provider-side port; orchestration owns persistence and first-turn dispatch. */
export class PiThreadSpawner extends Context.Service<
  PiThreadSpawner,
  {
    readonly spawn: (
      parentThreadId: ThreadId,
      request: PiBackgroundThreadRequest,
    ) => Effect.Effect<ThreadId, PiThreadSpawnError>;
  }
>()("t3/provider/Services/PiThreadSpawner") {}

export class PiThreadSpawnError extends Schema.TaggedError<PiThreadSpawnError>()(
  "PiThreadSpawnError",
  { message: Schema.String },
) {}
