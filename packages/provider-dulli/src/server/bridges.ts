/**
 * Use session-local factories, never singleton mutable handlers; prefixes claim UI first.
 * Notify handlers cannot await replies from the event pump; input interceptors run
 * in scoped fibers. onStart requires native identity; onStop runs once on exit/close.
 */
import type { DulliSettings } from "../settings.ts";
import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { PiRpcConnection, PiRpcRecord } from "./rpc.ts";

export interface DulliBridgeContext {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly instanceId: ProviderInstanceId;
  readonly settings: DulliSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly rpc: Pick<PiRpcConnection, "send" | "request">;
  readonly emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly getProviderThread: () => OrchestrationV2ProviderThread | null;
  /** Stable position for a bridge-owned card in the active parent turn. */
  readonly getItemOrdinal?: (nativeItemId: string) => number;
  readonly getActiveTurn: () => {
    readonly input: ProviderAdapterV2TurnInput;
    readonly providerTurn: OrchestrationV2ProviderTurn;
  } | null;
}
export interface DulliBridge {
  /** Native extension events whose server effects do not belong in the provider package. */
  readonly events?: ReadonlyArray<{
    readonly type: string;
    readonly handle: (event: PiRpcRecord) => Effect.Effect<void>;
  }>;
  readonly notify?: ReadonlyArray<{
    readonly prefix: string;
    readonly handle: (payload: string, event: PiRpcRecord) => Effect.Effect<void>;
  }>;
  readonly input?: ReadonlyArray<{
    readonly titlePrefix: string;
    readonly handle: (payload: string, event: PiRpcRecord) => Effect.Effect<PiRpcRecord>;
  }>;
  readonly onStart?: () => Effect.Effect<void>;
  /** Shared detach is loss of observation, not proof that native work stopped. */
  readonly onStop?: (reason: "detached" | "stopped") => Effect.Effect<void>;
  readonly hasPendingBackgroundWork?: () => boolean;
  readonly stopSubagent?: NonNullable<ProviderAdapterV2SessionRuntime["stopSubagent"]>;
}
export type DulliBridgeFactory = (
  context: DulliBridgeContext,
) => Effect.Effect<DulliBridge, never, Scope.Scope>;
export class DulliBridgeRegistry extends Context.Reference<ReadonlyArray<DulliBridgeFactory>>(
  "@t3tools/provider-dulli/bridges",
  { defaultValue: () => [] },
) {}

export class DulliSharedEnvironment extends Context.Reference<string | undefined>(
  "@t3tools/provider-dulli/bridges/DulliSharedEnvironment",
  { defaultValue: () => undefined },
) {}
