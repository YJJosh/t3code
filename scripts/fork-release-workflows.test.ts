// @effect-diagnostics nodeBuiltinImport:off - workflow fixtures are plain YAML files outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | ReadonlyArray<string>;
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowsDir = NodePath.resolve(import.meta.dirname, "../.github/workflows");

function readWorkflow(name: string): Workflow {
  return YAML.parse(NodeFS.readFileSync(NodePath.join(workflowsDir, name), "utf8")) as Workflow;
}

const hardDisabledWorkflows = {
  "deploy-relay.yml": ["deploy_relay"],
  "desktop-macos-preview.yml": ["build", "publish", "cleanup"],
  "mobile-eas-preview.yml": ["preview"],
  "mobile-eas-production.yml": ["production"],
  "publish-aur.yml": ["publish"],
  "web-preview.yml": ["deploy"],
} as const;

describe("fork release workflow safety", () => {
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
