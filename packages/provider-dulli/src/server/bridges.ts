/**
 * Session-local extension seam. Provide DulliBridgeRegistry with factories (never
 * singleton mutable handlers). Prefixes are claimed before ordinary UI handling.
 * Notify handlers must not await a reply delivered by the event pump; input
 * interceptors run in a scoped fiber and return the extension response fields.
 * onStart runs after native identity is known; onStop runs once on exit/close.
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
  readonly getActiveTurn: () => {
    readonly input: ProviderAdapterV2TurnInput;
    readonly providerTurn: OrchestrationV2ProviderTurn;
  } | null;
}
export interface DulliBridge {
  readonly notify?: ReadonlyArray<{
    readonly prefix: string;
    readonly handle: (payload: string, event: PiRpcRecord) => Effect.Effect<void>;
  }>;
  readonly input?: ReadonlyArray<{
    readonly titlePrefix: string;
    readonly handle: (payload: string, event: PiRpcRecord) => Effect.Effect<PiRpcRecord>;
  }>;
  readonly onStart?: () => Effect.Effect<void>;
  readonly onStop?: () => Effect.Effect<void>;
  readonly hasPendingBackgroundWork?: () => boolean;
}
export type DulliBridgeFactory = (
  context: DulliBridgeContext,
) => Effect.Effect<DulliBridge, never, Scope.Scope>;
export class DulliBridgeRegistry extends Context.Reference<ReadonlyArray<DulliBridgeFactory>>(
  "@t3tools/provider-dulli/bridges",
  { defaultValue: () => [] },
) {}
