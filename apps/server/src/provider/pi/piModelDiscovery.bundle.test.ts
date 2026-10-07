// @effect-diagnostics nodeBuiltinImport:off - verifies real packaged modules on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { expect, it } from "vite-plus/test";

import { selectCliRuntimeExternalDependencies } from "../../../../../scripts/lib/cli-external-packages.ts";
import serverPackageJson from "../../../package.json" with { type: "json" };

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

it("discovers Pi models with the SDK the server bundle ships with", async () => {
  const serverRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-sdk-bundle-"));
  // The entry lives beside the server sources so compilation uses the same dependency resolution.
  const entryRoot = await NodeFSP.mkdtemp(NodePath.join(serverRoot, ".pi-sdk-bundle-"));
  try {
    const app = NodePath.join(root, "app");
    const dist = NodePath.join(app, "apps/server/dist");
    await NodeFSP.writeFile(
      NodePath.join(entryRoot, "index.ts"),
      `export { discoverPiModels } from "../src/provider/pi/piModelDiscovery.ts";
export { layer } from "@effect/platform-node/NodeServices";
export { provide, runPromise } from "effect/Effect";`,
    );
    const vp = NodeURL.fileURLToPath(new URL("../bin/vp", import.meta.resolve("vite-plus/bin")));
    await execFile(
      process.execPath,
      [vp, "pack", NodePath.join(entryRoot, "index.ts"), "--out-dir", dist],
      { cwd: serverRoot, timeout: 60_000 },
    );

    // Release staging installs each selected package with its dependency
    // closure. Linking the SDK's real store directory gives Node that same
    // closure without granting the bundle any other package.
    const runtimeDependencies = selectCliRuntimeExternalDependencies(
      serverPackageJson.dependencies,
    );
    if (PI_SDK_PACKAGE in runtimeDependencies) {
      const sdkRoot = NodePath.resolve(
        NodeURL.fileURLToPath(import.meta.resolve(PI_SDK_PACKAGE)),
        "../..",
      );
      await NodeFSP.mkdir(NodePath.join(app, "node_modules/@earendil-works"), { recursive: true });
      await NodeFSP.symlink(
        sdkRoot,
        NodePath.join(app, "node_modules", PI_SDK_PACKAGE),
        "junction",
      );
    }
    // A dependency in a parent directory would let a broken package pass this test.
    for (let parent = NodePath.dirname(app); ; parent = NodePath.dirname(parent)) {
      await expect(NodeFSP.access(NodePath.join(parent, "node_modules"))).rejects.toThrow();
      if (parent === NodePath.dirname(parent)) break;
    }

    const home = NodePath.join(root, "home");
    await NodeFSP.mkdir(NodePath.join(home, "agent"), { recursive: true });
    const runner = NodePath.join(dist, "check.mjs");
    await NodeFSP.writeFile(
      runner,
      `import assert from "node:assert/strict";
import path from "node:path";
import { discoverPiModels, layer, provide, runPromise } from "./index.mjs";
const home = process.argv[2];
const result = await runPromise(provide(discoverPiModels({
  agentDir: path.join(home, "agent"),
  cwd: home,
  // Discovery checks configured auth presence; it never sends a model request.
  environment: { HOME: home, PI_OFFLINE: "1", OPENAI_API_KEY: "t3-discovery-fixture-not-a-credential" },
}), layer));
assert.equal(result.error, undefined);
assert.ok(result.models.some((model) => model.slug === "openai/gpt-6-astra"));
console.log("Packaged Pi model discovery passed.");`,
    );
    const result = await execFile(process.execPath, ["--no-global-search-paths", runner, home], {
      cwd: app,
      env: { ...process.env, NODE_PATH: "" },
      timeout: 30_000,
    });
    expect(result.stdout).toContain("Packaged Pi model discovery passed.");
  } finally {
    await NodeFSP.rm(entryRoot, { recursive: true, force: true });
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 120_000);
