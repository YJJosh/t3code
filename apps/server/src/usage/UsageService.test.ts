import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";
import { resolveUsageSourceReadCoverage, resolveUsageTranscriptDirs } from "./UsageService.ts";

it.layer(NodeServices.layer)("UsageService", (it) => {
  it.effect("resolves and deduplicates every configured Codex and Claude instance home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
      const codexPersonal = path.join(root, "codex-personal");
      const codexWork = path.join(root, "codex-work");
      const claudePersonal = path.join(root, "claude-personal");
      const claudeProjects = path.join(claudePersonal, ".claude", "projects");
      yield* fileSystem.makeDirectory(claudeProjects, { recursive: true });

      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            homePath: path.join(root, "ignored-legacy-codex"),
          },
          claudeAgent: {
            ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
            homePath: path.join(root, "ignored-legacy-claude"),
          },
        },
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: codexPersonal },
          },
          [ProviderInstanceId.make("codex_work")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: codexWork },
          },
          [ProviderInstanceId.make("codex_duplicate")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: codexPersonal },
          },
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: claudePersonal },
          },
          [ProviderInstanceId.make("claude_duplicate")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: claudePersonal },
          },
        },
      };

      const directories = yield* resolveUsageTranscriptDirs(settings);

      expect(directories).toHaveLength(3);
      expect(directories).toEqual(
        expect.arrayContaining([
          { provider: "codex", dir: path.join(codexPersonal, "sessions") },
          { provider: "codex", dir: path.join(codexWork, "sessions") },
          { provider: "claude", dir: claudeProjects },
        ]),
      );
      expect(directories.some(({ dir }) => dir.includes("ignored-legacy"))).toBe(false);
    }),
  );

  it.effect("reports unreadable transcript files as partial source coverage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
      const missingTranscript = path.join(root, "vanished.jsonl");

      expect(
        yield* Effect.promise(() => readTranscriptRecords(missingTranscript, "codex")),
      ).toBeNull();
      expect(resolveUsageSourceReadCoverage(1)).toEqual({
        status: "partial",
        message: "1 transcript file could not be read.",
      });
      expect(resolveUsageSourceReadCoverage(0)).toEqual({ status: "ok", message: null });
    }),
  );
});
