import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { createVpPmPublishArgs, resolvePublishIdentity } from "./cli.ts";

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
