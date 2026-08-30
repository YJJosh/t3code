import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  resolvePiAgentDir,
  resolvePiSubagentTranscriptDirs,
  resolvePiTranscriptDir,
} from "./UsageService.ts";

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
