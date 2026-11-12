// @effect-diagnostics nodeBuiltinImport:off - workflow fixtures and shell validation run outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly uses?: string;
  readonly steps?: ReadonlyArray<{ readonly id?: string; readonly run?: string }>;
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowsDir = NodePath.resolve(import.meta.dirname, "../.github/workflows");

function readWorkflow(name: string): Workflow {
  return Schema.decodeSync(fromYaml(Schema.Unknown))(
    NodeFS.readFileSync(NodePath.join(workflowsDir, name), "utf8"),
  ) as Workflow;
}

function runPreflightStep(
  stepId: string,
  env: Readonly<Record<string, string>>,
  tags: ReadonlyArray<string> = [],
) {
  const workflow = readWorkflow("fork-desktop-release.yml");
  const script = workflow.jobs.preflight?.steps?.find((step) => step.id === stepId)?.run;
  if (!script) throw new Error(`Missing preflight step: ${stepId}`);

  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dulli-release-preflight-"));
  const outputPath = NodePath.join(root, "output");
  try {
    const git = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        ...args,
      ]);
    git("init", "--quiet");
    if (tags.length > 0) {
      git("commit", "--quiet", "--allow-empty", "-m", "c");
      for (const tag of tags) git("tag", tag);
    }
    const result = NodeChildProcess.spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ...env, GITHUB_OUTPUT: outputPath },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stderr: result.stderr,
      output: NodeFS.existsSync(outputPath) ? NodeFS.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function validateReleaseVersion(version: string) {
  return runPreflightStep("release_meta", { RAW_VERSION: version });
}

function resolvePreviousTag(currentTag: string, tags: ReadonlyArray<string>) {
  return runPreflightStep("previous_tag", { CURRENT_TAG: currentTag }, tags).output;
}

describe("fork release safety", () => {
  it.each(["0.1.9-dulli.0", "v0.1.9-dulli.1", "0.2.15-dulli.3"])(
    "accepts canonical fork versions (%s)",
    (version) => {
      const normalized = version.replace(/^v/, "");
      expect(validateReleaseVersion(version)).toEqual({
        status: 0,
        stderr: "",
        output: `version=${normalized}\ntag=v${normalized}\n`,
      });
    },
  );
  it.each([
    "0.0.40-pi.1",
    "0.1.9",
    "0.1.9-dulli.01",
    "0.01.9-dulli.1",
    "0.1.9-dulli.1\n",
    "0.1.9-dulli.1+build",
    "1.0.0-dulli.1",
    "0.1.1000-dulli.1",
    "0.1.9-dulli.10000",
    "0.999.999-dulli.1",
  ])("rejects invalid versions or overflowing APK slots (%s)", (version) => {
    const result = validateReleaseVersion(version);
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });
  it("compares notes against the preceding Dulli release rather than upstream tags", () => {
    expect(
      resolvePreviousTag("v0.1.9-dulli.2", [
        "v0.1.9",
        "v0.1.9-dulli.1",
        "v0.1.9-dulli.3",
        "v0.1.8-dulli.99",
      ]),
    ).toBe("previous_tag=v0.1.9-dulli.1\n");
    expect(resolvePreviousTag("v0.1.9-dulli.1", ["v0.1.9"])).toBe("previous_tag=\n");
  });
  it.each([
    "release",
    "release-desktop",
    "deploy-relay",
    "relay-preview",
    "relay-preview-cleanup",
    "desktop-macos-preview",
    "desktop-macos-preview-publish",
    "mobile-eas-preview",
    "mobile-eas-preview-fork",
    "mobile-eas-production",
    "publish-aur",
    "web-preview",
    "mobile-android-apk",
    "mobile-dev-client",
  ])("prevents %s from publishing or deploying in the fork", (name) => {
    const workflow = readWorkflow(`${name}.yml`);
    expect(Object.keys(workflow.on)).toEqual([
      ["release-desktop", "publish-aur"].includes(name) ? "workflow_call" : "workflow_dispatch",
    ]);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toContain("github.repository == 'pingdotgg/t3code'");
      if (job.uses?.startsWith("./.github/workflows/")) {
        const called = readWorkflow(NodePath.basename(job.uses));
        expect(called.on).toHaveProperty("workflow_call");
      }
    }
  });
});
