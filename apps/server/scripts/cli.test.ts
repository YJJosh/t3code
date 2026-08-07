import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { createVpPmPublishArgs, redactOtpArgs, resolvePublishIdentity } from "./cli.ts";

describe("server publish CLI", () => {
  it("builds fork publish arguments including provenance, dry-run, and OTP", () => {
    const args = createVpPmPublishArgs(
      {
        access: "public",
        tag: "latest",
        provenance: true,
        dryRun: true,
        otp: Option.some("123456"),
      },
      "@yjosh/t3",
    );

    assert.deepEqual(args, [
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
      "--otp",
      "123456",
    ]);
  });

  it("redacts OTP values from logged and error command arguments", () => {
    assert.deepEqual(redactOtpArgs(["publish", "--otp", "123456", "--otp=654321"]), [
      "publish",
      "--otp",
      "***",
      "--otp=***",
    ]);
  });

  it("overrides the package identity used for a fork publish", () => {
    assert.deepEqual(
      resolvePublishIdentity(
        {
          appVersion: Option.some("0.0.31-pi.4"),
          packageName: Option.some("@yjosh/t3"),
          repositoryUrl: Option.some("https://github.com/YJJosh/t3code"),
        },
        {
          version: "0.0.31",
          packageName: "t3",
          repositoryUrl: "https://github.com/pingdotgg/t3code",
        },
      ),
      {
        version: "0.0.31-pi.4",
        packageName: "@yjosh/t3",
        repositoryUrl: "https://github.com/YJJosh/t3code",
      },
    );
  });
});
