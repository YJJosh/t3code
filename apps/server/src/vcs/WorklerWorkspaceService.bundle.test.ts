// @effect-diagnostics nodeBuiltinImport:off - verifies real packaged modules and Git repositories on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { expect, it } from "vite-plus/test";

import { selectCliRuntimeExternalDependencies } from "../../../../scripts/lib/cli-external-packages.ts";
import serverPackageJson from "../../package.json" with { type: "json" };

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it("creates, lists and removes Workler clones from an isolated server bundle", async () => {
  const serverRoot = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workler-bundle-"));
  // The entry lives beside the server sources so compilation uses the same dependency resolution.
  // Only the emitted modules and selected runtime packages are copied into the isolated install.
  const entryRoot = await NodeFSP.mkdtemp(NodePath.join(serverRoot, ".workler-bundle-"));
  try {
    const app = NodePath.join(root, "app");
    const dist = NodePath.join(app, "apps/server/dist");
    await NodeFSP.writeFile(
      NodePath.join(entryRoot, "index.ts"),
      `export { make } from "../src/vcs/WorklerWorkspaceService.ts";
export { runPromise } from "effect/Effect";`,
    );
    const vp = NodeURL.fileURLToPath(new URL("../bin/vp", import.meta.resolve("vite-plus/bin")));
    await execFile(
      process.execPath,
      [vp, "pack", NodePath.join(entryRoot, "index.ts"), "--out-dir", dist],
      { cwd: serverRoot, timeout: 60_000 },
    );

    const runtimeDependencies = selectCliRuntimeExternalDependencies(
      serverPackageJson.dependencies,
    );
    if ("workler" in runtimeDependencies) {
      await NodeFSP.cp(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("workler/package.json"))),
        NodePath.join(app, "node_modules/workler"),
        { recursive: true, dereference: true },
      );
    }
    // A dependency in a parent directory would let a broken package pass this test.
    for (let parent = NodePath.dirname(app); ; parent = NodePath.dirname(parent)) {
      await expect(NodeFSP.access(NodePath.join(parent, "node_modules"))).rejects.toThrow();
      if (parent === NodePath.dirname(parent)) break;
    }

    const repo = NodePath.join(root, "project");
    await NodeFSP.mkdir(repo);
    await execFile("git", ["init", "--initial-branch=main", repo]);
    await NodeFSP.writeFile(NodePath.join(repo, ".gitignore"), ".worktrees/\nlocal.txt\n");
    await NodeFSP.writeFile(NodePath.join(repo, ".workler"), "copy local.txt\n");
    await NodeFSP.writeFile(NodePath.join(repo, "tracked.txt"), "committed content\n");
    await execFile("git", ["add", "."], { cwd: repo });
    await execFile(
      "git",
      [
        "-c",
        "user.name=T3 Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: repo },
    );
    const upstream = NodePath.join(root, "upstream.git");
    await execFile("git", ["init", "--bare", "--initial-branch=main", upstream]);
    await execFile("git", ["remote", "add", "origin", upstream], { cwd: repo });
    await execFile("git", ["push", "-u", "origin", "main"], { cwd: repo });
    await NodeFSP.writeFile(NodePath.join(repo, "local.txt"), "copied by Workler\n");

    const runner = NodePath.join(dist, "check.mjs");
    await NodeFSP.writeFile(
      runner,
      `import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { make, runPromise } from "./index.mjs";
const root = process.argv[2];
const service = await runPromise(make);
const initial = await runPromise(service.listWorkspaces(root));
assert.ok(initial.some((workspace) => workspace.isMain));
assert.equal(createRequire(import.meta.url)("workler/package.json").version, ${JSON.stringify(serverPackageJson.dependencies.workler)});
const created = await runPromise(service.createWorkspace({ root, name: "bundle-check", branch: "feature/bundle-check", base: "origin/main" }));
assert.equal(created.branch, "feature/bundle-check");
assert.equal(created.path, path.join(root, ".worktrees/bundle-check"));
assert.ok((await stat(path.join(created.path, ".git"))).isDirectory());
assert.equal(await readFile(path.join(created.path, "tracked.txt"), "utf8"), "committed content\\n");
assert.equal(await readFile(path.join(created.path, "local.txt"), "utf8"), "copied by Workler\\n");
const listed = await runPromise(service.listWorkspaces(root));
assert.ok(listed.some((workspace) => workspace.name === "bundle-check" && workspace.isClone && workspace.branch === created.branch));
const removed = await runPromise(service.removeWorkspace({ root, name: "bundle-check", force: true }));
assert.equal(removed.path, created.path);
await assert.rejects(stat(created.path), { code: "ENOENT" });
assert.ok(!(await runPromise(service.listWorkspaces(root))).some((workspace) => workspace.name === "bundle-check"));
console.log("Packaged Workler clone lifecycle passed.");`,
    );
    const result = await execFile(process.execPath, ["--no-global-search-paths", runner, repo], {
      cwd: app,
      env: { ...process.env, NODE_PATH: "" },
      timeout: 30_000,
    });
    expect(result.stdout).toContain("Packaged Workler clone lifecycle passed.");
  } finally {
    await NodeFSP.rm(entryRoot, { recursive: true, force: true });
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 120_000);
