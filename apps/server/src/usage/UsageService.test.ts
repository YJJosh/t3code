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
import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";
import {
  resolvePiSubagentTranscriptDirs,
  resolveUsageSourceReadCoverage,
  resolveUsageTranscriptDirs,
} from "./UsageService.ts";

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

      expect(directories.filter(({ provider }) => provider !== "pi")).toHaveLength(3);
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

  it.effect("uses inherited Claude config homes when an instance has no explicit home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
      const inheritedHome = path.join(root, "inherited-claude");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: "" },
          },
        },
      };

      const directories = yield* resolveUsageTranscriptDirs(settings, {
        CLAUDE_CONFIG_DIR: inheritedHome,
      });

      expect(directories).toContainEqual({
        provider: "claude",
        dir: path.join(inheritedHome, "projects"),
      });
    }),
  );

  it.effect("resolves every configured Pi session home with environment overrides", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("tmp", "pi-home");
      const inheritedAgentDir = path.join("tmp", "pi-inherited");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("pi")]: {
            driver: ProviderDriverKind.make("pi"),
            config: { agentDir: "" },
          },
          [ProviderInstanceId.make("pi_work")]: {
            driver: ProviderDriverKind.make("pi"),
            config: { agentDir: "~/pi-work" },
          },
          [ProviderInstanceId.make("pi_duplicate")]: {
            driver: ProviderDriverKind.make("pi"),
            config: { agentDir: "" },
          },
        },
      };

      const directories = yield* resolveUsageTranscriptDirs(settings, {
        HOME: home,
        PI_CODING_AGENT_DIR: inheritedAgentDir,
      });

      expect(directories).toEqual(
        expect.arrayContaining([
          { provider: "pi", dir: path.join(inheritedAgentDir, "sessions") },
          { provider: "pi", dir: path.join(home, "pi-work", "sessions") },
        ]),
      );
      expect(directories.filter(({ provider }) => provider === "pi")).toHaveLength(2);
    }),
  );

  it.effect("prefers Pi's session-directory environment override", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("pi")]: {
            driver: ProviderDriverKind.make("pi"),
            config: { agentDir: "/ignored" },
          },
        },
      };

      expect(
        yield* resolveUsageTranscriptDirs(settings, {
          HOME: "/home/pi",
          PI_CODING_AGENT_SESSION_DIR: "~/custom-sessions",
        }),
      ).toContainEqual({ provider: "pi", dir: path.join("/home/pi", "custom-sessions") });
    }),
  );

  it.effect("discovers deduplicated pi-subagents session roots from project ancestors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-subagents-" });
      const project = path.join(root, "workspace", "project");
      const runs = path.join(root, "workspace", ".pi-subagents", "runs");
      yield* fileSystem.makeDirectory(project, { recursive: true });
      yield* fileSystem.makeDirectory(runs, { recursive: true });

      expect(yield* resolvePiSubagentTranscriptDirs([project, project])).toEqual([runs]);
    }),
  );

  it.effect("reports unreadable and malformed transcript coverage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
      const missingTranscript = path.join(root, "vanished.jsonl");
      const malformedTranscript = path.join(root, "malformed.jsonl");
      const piTranscript = path.join(root, "pi.jsonl");
      yield* fileSystem.writeFileString(malformedTranscript, '{"usage":\n');
      yield* fileSystem.writeFileString(
        piTranscript,
        [
          `{"type":"session","version":3,"id":"pi-session","timestamp":"2026-08-07T00:00:00.000Z","cwd":"${root}"}`,
          '{"type":"message","timestamp":"2026-08-07T00:01:00.000Z","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.6-sol","usage":{"input":10,"output":5,"cacheRead":20,"cacheWrite":2,"cost":{"total":0.1}}}}',
        ].join("\n"),
      );

      expect(
        yield* Effect.promise(() => readTranscriptRecords(missingTranscript, "codex")),
      ).toBeNull();
      expect(
        yield* Effect.promise(() => readTranscriptRecords(malformedTranscript, "claude")),
      ).toEqual({ records: [], malformedRecords: 1, projectPaths: [] });
      expect(yield* Effect.promise(() => readTranscriptRecords(piTranscript, "pi"))).toEqual({
        records: [
          expect.objectContaining({
            provider: "pi",
            model: "openai-codex/gpt-5.6-sol",
            sessionId: "pi-session",
            reportedCostUsd: 0.1,
          }),
        ],
        malformedRecords: 0,
        projectPaths: [root],
      });
      expect(yield* Effect.promise(() => listTranscriptFiles(missingTranscript, 0))).toEqual({
        files: [],
        unreadableDirectories: 1,
      });
      expect(
        resolveUsageSourceReadCoverage({ unreadableFiles: 1, unreadableDirectories: 1 }),
      ).toEqual({
        status: "partial",
        message: "1 transcript directory could not be read; 1 transcript file could not be read.",
      });
      expect(
        resolveUsageSourceReadCoverage({ unreadableFiles: 0, unreadableDirectories: 0 }),
      ).toEqual({ status: "ok", message: null });
    }),
  );
});
