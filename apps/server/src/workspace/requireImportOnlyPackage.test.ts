// @effect-diagnostics nodeBuiltinImport:off - the test builds a real package on disk and loads it in a real Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

// Mirrors the published @ff-labs/fff-node: an ES module whose exports map only
// has `import`, so a plain `require` cannot load it.
async function writeImportOnlyPackage(directory: string) {
  const packageDirectory = NodePath.join(directory, "node_modules", "import-only");
  await NodeFSP.mkdir(NodePath.join(packageDirectory, "dist"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "import-only",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(packageDirectory, "dist", "index.js"),
    "export const answer = 42;\n",
  );
}

it("requires a package whose exports only map `import`", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-import-only-"));
  try {
    await writeImportOnlyPackage(directory);
    const probePath = NodePath.join(directory, "probe.mjs");

    assert.throws(
      () => NodeModule.createRequire(probePath)("import-only"),
      /No "exports" main defined/,
    );

    // Resolve from the fixture with Node's own `require` and `import.meta.resolve`,
    // the way the server does from its install location.
    await NodeFSP.writeFile(
      probePath,
      `import * as NodeModule from "node:module";
const { requireImportOnlyPackage } = await import(${JSON.stringify(new URL("./requireImportOnlyPackage.ts", import.meta.url).href)});
const { answer } = requireImportOnlyPackage(
  NodeModule.createRequire(import.meta.url),
  (specifier) => import.meta.resolve(specifier),
  "import-only",
);
console.log(answer);
`,
    );
    const child = NodeChildProcess.spawnSync(process.execPath, [probePath], { encoding: "utf8" });

    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(child.stdout.trim(), "42");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
