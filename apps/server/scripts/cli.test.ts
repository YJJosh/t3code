import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  createVpPmPublishArgs,
  RESOURCE_MONITOR_EXECUTABLE_FILES,
  resolvePublishIdentity,
} from "./cli.ts";

describe("server publish CLI", () => {
  it("targets an overridden fork package when publishing", () => {
    assert.deepEqual(
      createVpPmPublishArgs(
        {
          access: "public",
          tag: "latest",
          provenance: true,
          dryRun: true,
        },
        "@yjosh/t3",
      ),
      [
        "publish",
        "--filter",
        "@yjosh/t3",
        "--access",
        "public",
        "--tag",
        "latest",
        "--no-git-checks",
        "--provenance",
        "--dry-run",
      ],
    );
  });

  it("marks bundled resource monitors as executable in pnpm tarballs", () => {
    assert.deepEqual(RESOURCE_MONITOR_EXECUTABLE_FILES, [
      "./dist/resource-monitor/darwin-arm64/t3-resource-monitor",
      "./dist/resource-monitor/darwin-x64/t3-resource-monitor",
      "./dist/resource-monitor/linux-x64/t3-resource-monitor",
      "./dist/resource-monitor/win32-x64/t3-resource-monitor.exe",
    ]);
  });

  it("overrides the package identity used for a fork publish", () => {
    assert.deepEqual(
      resolvePublishIdentity(
        {
          appVersion: Option.some("0.0.36-pi.1"),
          packageName: Option.some("@yjosh/t3"),
          repositoryUrl: Option.some("https://github.com/YJJosh/t3code"),
        },
        {
          version: "0.0.36",
          packageName: "t3",
          repositoryUrl: "https://github.com/pingdotgg/t3code",
        },
      ),
      {
        version: "0.0.36-pi.1",
        packageName: "@yjosh/t3",
        repositoryUrl: "https://github.com/YJJosh/t3code",
      },
    );
  });
});
