// @effect-diagnostics nodeBuiltinImport:off - workflow fixtures and shell validation run outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly steps?: ReadonlyArray<{ readonly id?: string; readonly run?: string }>;
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowsDir = NodePath.resolve(import.meta.dirname, "../.github/workflows");

function readWorkflow(name: string): Workflow {
  return YAML.parse(NodeFS.readFileSync(NodePath.join(workflowsDir, name), "utf8")) as Workflow;
}

function validateReleaseVersion(version: string) {
  const workflow = readWorkflow("fork-desktop-release.yml");
  const script = workflow.jobs.preflight?.steps?.find((step) => step.id === "release_meta")?.run;
  if (!script) throw new Error("Missing release validation step");

  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dulli-release-version-"));
  const outputPath = NodePath.join(root, "output");
  try {
    NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
    const result = NodeChildProcess.spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RAW_VERSION: version, GITHUB_OUTPUT: outputPath },
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

const hardDisabledWorkflows = {
  "cursor-hygiene-webhook.yml": ["forward"],
  "deploy-relay.yml": ["deploy_relay"],
  "desktop-macos-preview.yml": ["build", "publish", "cleanup"],
  "mobile-eas-preview.yml": ["preview"],
  "mobile-eas-production.yml": ["production"],
  "publish-aur.yml": ["publish"],
  "web-preview.yml": ["deploy"],
} as const;

describe("fork release workflow safety", () => {
  it.each([
    ["0.0.40-pi.1", "0.0.40-pi.1"],
    ["v0.0.40-pi.1", "0.0.40-pi.1"],
    ["0.0.40-dulli.2", "0.0.40-dulli.2"],
    ["v0.0.40-dulli.2", "0.0.40-dulli.2"],
    ["0.0.41-dulli.0", "0.0.41-dulli.0"],
  ])("accepts the migration and Dulli release sequence (%s)", (version, normalized) => {
    expect(validateReleaseVersion(version)).toEqual({
      status: 0,
      stderr: "",
      output: `version=${normalized}\ntag=v${normalized}\n`,
    });
  });

  it.each(["0.0.40-dulli.0", "0.0.40-dulli.1"])(
    "rejects build slots that cannot upgrade the migration APK (%s)",
    (version) => {
      const result = validateReleaseVersion(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("0.0.40-dulli.2 or newer");
      expect(result.output).toBe("");
    },
  );

  it.each([
    "0.0.36-pi.3",
    "0.0.39-pi.1",
    "0.0.40-pi.2",
    "0.0.41-pi.1",
    "0.0.40-beta.1",
    "0.0.40",
    "0.0.040-dulli.1",
    "0.0.40-dulli.01",
    "0.0.40-dulli.1+build",
    "0.0.40-dulli.1\n",
  ])("rejects non-canonical new release versions (%s)", (version) => {
    const result = validateReleaseVersion(version);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.0.<patch>-dulli.<build>");
    expect(result.output).toBe("");
  });

  it("keeps Ubuntu CI setup independent of upstream's runner vendor", () => {
    const ci = NodeFS.readFileSync(NodePath.join(workflowsDir, "ci.yml"), "utf8");
    const aptSetup = NodeFS.readFileSync(
      NodePath.resolve(workflowsDir, "../actions/setup-apt-mirrors/action.yml"),
      "utf8",
    );
    expect(ci).not.toMatch(/blacksmith|self-hosted/i);
    expect(aptSetup).not.toMatch(/blacksmith|self-hosted/i);
    expect(ci).toContain("libsecret-1-dev");
    expect(aptSetup).toContain("/etc/apt/t3-ubuntu-mirrors.txt");
  });

  it("keeps every upstream release job hard-disabled", () => {
    const workflow = readWorkflow("release.yml");

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.jobs)).not.toHaveLength(0);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("${{ false }}");
    }
  });

  it("keeps upstream infrastructure and preview publishers hard-disabled", () => {
    for (const [name, jobs] of Object.entries(hardDisabledWorkflows)) {
      const workflow = readWorkflow(name);
      for (const jobName of jobs) {
        expect(workflow.jobs[jobName]?.if, `${name}:${jobName}`).toBe("${{ false }}");
      }
    }
  });

  it("allows Dulli publishing only through manual fork release dispatch", () => {
    const workflow = readWorkflow("fork-desktop-release.yml");
    const source = NodeFS.readFileSync(
      NodePath.join(workflowsDir, "fork-desktop-release.yml"),
      "utf8",
    );

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.release?.needs).toEqual(["preflight", "build", "build_android"]);
    expect(workflow.jobs.publish_cli?.needs).toEqual(["preflight", "build", "release"]);
    expect(source).not.toMatch(/expo\/expo-github-action|\beas\s+(?:build|submit|update)\b/i);
    expect(source).not.toMatch(/deploy-relay|t3code-relay|vercel deploy/i);
  });
});
