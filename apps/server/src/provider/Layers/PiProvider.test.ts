import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as PiModelDiscovery from "../pi/piModelDiscovery.ts";
import type { PiModelDiscoveryResult } from "../pi/piModelDiscovery.ts";
import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./PiProvider.ts";

vi.mock("../pi/piModelDiscovery.ts", { spy: true });

const decodePiSettings = Schema.decodeSync(PiSettings);

const discoveryFailure = (error: string): PiModelDiscoveryResult => ({
  models: [],
  auth: { status: "unknown" },
  slashCommands: [],
  skills: [],
  error,
});

const discoverySuccess: PiModelDiscoveryResult = {
  models: [
    {
      slug: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      subProvider: "anthropic",
      isCustom: false,
      capabilities: null,
    },
  ],
  auth: { status: "authenticated" },
  slashCommands: [{ name: "review", description: "Review the current changes" }],
  skills: [],
};

type DiscoveryEffect = ReturnType<typeof PiModelDiscovery.discoverPiModels>;

const runPiChecks = (discoveries: ReadonlyArray<DiscoveryEffect>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-provider-" });
      const piPath = writeFakeCli({
        directory,
        name: "pi",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("pi 0.85.1\\n");',
          "  process.exit(0);",
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
      let discoveryIndex = 0;
      const discoveryMock = vi
        .spyOn(PiModelDiscovery, "discoverPiModels")
        .mockImplementation(
          () =>
            discoveries[Math.min(discoveryIndex++, discoveries.length - 1)] ??
            Effect.die("Missing Pi discovery test result"),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => discoveryMock.mockRestore()));

      const settings = decodePiSettings({
        enabled: true,
        binaryPath: piPath,
        agentDir: directory,
      });
      const snapshots = [];
      for (const _ of discoveries) {
        snapshots.push(yield* checkPiProviderStatus(settings));
      }
      return snapshots;
    }),
  );

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("advertises the configured Pi profile as a model option", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(
        decodePiSettings({
          profile: "reviewer",
          customModels: ["anthropic/claude-sonnet-5"],
        }),
      );

      expect(snapshot).toMatchObject({ showRuntimeModeToggle: false });

      const profileDescriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "profile",
      );
      expect(profileDescriptor).toMatchObject({
        id: "profile",
        label: "Profile",
        type: "select",
        currentValue: "reviewer",
        options: [{ id: "reviewer", label: "reviewer", isDefault: true }],
      });
    }),
  );
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports an actionable error when model discovery fails", () =>
    Effect.gen(function* () {
      const [snapshot] = yield* runPiChecks([
        Effect.succeed(discoveryFailure("Pi SDK discovery worker exited 9.")),
      ]);

      expect(snapshot).toMatchObject({
        installed: true,
        version: "0.85.1",
        status: "error",
        auth: { status: "unknown" },
        models: [],
        message: "Pi model discovery failed: Pi SDK discovery worker exited 9.",
      });
    }),
  );

  it.effect("times out model discovery without reporting Pi as ready", () =>
    Effect.gen(function* () {
      const discoveryStarted = yield* Deferred.make<void>();
      const probeFiber = yield* runPiChecks([
        Deferred.succeed(discoveryStarted, undefined).pipe(Effect.andThen(Effect.never)),
      ]).pipe(Effect.forkChild);

      yield* Deferred.await(discoveryStarted);
      yield* TestClock.adjust("15 seconds");
      const [snapshot] = yield* Fiber.join(probeFiber);

      expect(snapshot).toMatchObject({
        installed: true,
        version: "0.85.1",
        status: "error",
        auth: { status: "unknown" },
        models: [],
        message: "Pi model discovery timed out after 15 seconds.",
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("distinguishes an unexpected discovery defect from a timeout", () =>
    Effect.gen(function* () {
      const [snapshot] = yield* runPiChecks([Effect.die("unexpected discovery defect")]);

      expect(snapshot).toMatchObject({
        status: "error",
        auth: { status: "unknown" },
        message: "Pi model discovery failed unexpectedly.",
      });
    }),
  );

  it.effect(
    "keeps authenticated models with a warning when discovery has partial diagnostics",
    () =>
      Effect.gen(function* () {
        const [snapshot] = yield* runPiChecks([
          Effect.succeed({ ...discoverySuccess, error: "Extension alpha failed to initialize." }),
        ]);

        expect(snapshot).toMatchObject({
          status: "warning",
          auth: { status: "authenticated" },
          message: "Pi model discovery failed: Extension alpha failed to initialize.",
        });
        expect(snapshot?.models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-5"]);
        expect(snapshot?.slashCommands).toEqual([
          { name: "review", description: "Review the current changes" },
        ]);
      }),
  );

  it.effect("returns to ready after a failed discovery recovers", () =>
    Effect.gen(function* () {
      const [failed, recovered] = yield* runPiChecks([
        Effect.succeed(discoveryFailure("Temporary worker failure.")),
        Effect.succeed(discoverySuccess),
      ]);

      expect(failed?.status).toBe("error");
      expect(recovered).toMatchObject({
        installed: true,
        version: "0.85.1",
        status: "ready",
        auth: { status: "authenticated" },
      });
      expect(recovered?.message).toBeUndefined();
      expect(recovered?.models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-5"]);
    }),
  );

  it.effect("keeps the existing unauthenticated warning", () =>
    Effect.gen(function* () {
      const [snapshot] = yield* runPiChecks([
        Effect.succeed({
          models: [],
          auth: { status: "unauthenticated" },
          slashCommands: [],
          skills: [],
        }),
      ]);

      expect(snapshot).toMatchObject({
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Pi is installed but no model credentials are configured.",
      });
    }),
  );
});
