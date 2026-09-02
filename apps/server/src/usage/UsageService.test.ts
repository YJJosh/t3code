import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  resolveConfiguredPiTranscriptDirs,
  resolvePiAgentDir,
  resolvePiSubagentTranscriptDirs,
  resolvePiTranscriptDir,
} from "./UsageService.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

it.layer(NodeServices.layer)("Pi transcript roots", (it) => {
  it.effect("matches Pi's standard and legacy app-name environment precedence", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      expect(resolvePiAgentDir({ HOME: "/home/pi" }, path)).toBe("/home/pi/.pi/agent");
      expect(resolvePiTranscriptDir({ HOME: "/home/pi" }, path)).toBe(
        "/home/pi/.pi/agent/sessions",
      );
      // Pi's own name wins when both its current and predecessor environment
      // variables are inherited by a long-lived server process.
      expect(
        resolvePiAgentDir(
          {
            HOME: "/home/pi",
            PI_CODING_AGENT_DIR: "/pi-agent",
            TAU_CODING_AGENT_DIR: "/tau-agent",
          },
          path,
        ),
      ).toBe("/pi-agent");
      expect(
        resolvePiAgentDir(
          { HOME: "/home/pi", PI_CODING_AGENT_DIR: "/pi-agent" },
          path,
          "~/configured-agent",
        ),
      ).toBe("/home/pi/configured-agent");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", PI_CODING_AGENT_DIR: "/pi-agent" },
          path,
          "~/configured-agent",
        ),
      ).toBe("/home/pi/configured-agent/sessions");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", TAU_CODING_AGENT_SESSION_DIR: "~/tau-sessions" },
          path,
        ),
      ).toBe("/home/pi/tau-sessions");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", PI_CODING_AGENT_SESSION_DIR: "relative-sessions" },
          path,
        ),
      ).toBe(path.resolve("relative-sessions"));
    }),
  );

  it.effect("uses the legacy Pi settings when no explicit default instance exists", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providers: { pi: { agentDir: "~/legacy-agent" } },
      });

      expect(
        resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path).map(
          (directory) => directory.dir,
        ),
      ).toEqual([
        "/home/pi/legacy-agent/sessions",
        "/home/pi/legacy-agent",
        "/home/pi/legacy-agent/.pi-subagents/runs",
      ]);
    }),
  );

  it.effect("scans and de-duplicates roots from every explicit Pi instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providers: { pi: { agentDir: "~/ignored-legacy-agent" } },
        providerInstances: {
          pi: {
            driver: "pi",
            config: { agentDir: "~/primary-agent" },
            environment: [{ name: "PI_CODING_AGENT_SESSION_DIR", value: "~/primary-sessions" }],
          },
          pi_work: {
            driver: "pi",
            config: { agentDir: "~/work-agent" },
            environment: [
              { name: "HOME", value: "/home/work" },
              { name: "PI_CODING_AGENT_SESSION_DIR", value: "~/work-sessions" },
            ],
          },
          pi_work_duplicate: {
            driver: "pi",
            config: { agentDir: "~/work-agent" },
            environment: [
              { name: "HOME", value: "/home/work" },
              { name: "PI_CODING_AGENT_SESSION_DIR", value: "~/work-sessions" },
            ],
          },
          codex: { driver: "codex", config: {} },
        },
      });

      const dirs = resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path);
      expect(dirs.map((directory) => directory.dir)).toEqual([
        "/home/pi/primary-sessions",
        "/home/pi/primary-agent",
        "/home/pi/primary-agent/.pi-subagents/runs",
        "/home/work/work-sessions",
        "/home/work/work-agent",
        "/home/work/work-agent/.pi-subagents/runs",
      ]);
    }),
  );

  it.effect("coalesces overlapping standard and legacy Pi roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providerInstances: {
          pi: {
            driver: "pi",
            config: { agentDir: "/tmp/pi-agent" },
            environment: [{ name: "PI_CODING_AGENT_SESSION_DIR", value: "/tmp/pi-agent" }],
          },
        },
      });

      const dirs = resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path);
      expect(dirs).toEqual([
        {
          provider: "pi",
          dir: "/tmp/pi-agent",
          scanOptions: { maxDepth: 1 },
          completeForCachePruning: false,
        },
        {
          provider: "pi",
          dir: "/tmp/pi-agent/.pi-subagents/runs",
          scanOptions: { maxDepth: 2, piSubagentSessionsOnly: true },
        },
      ]);
    }),
  );

  it.effect("finds one project-ancestor subagent root for repeated Pi sessions", () =>
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
});
