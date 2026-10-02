#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
  type WebAssetBrand,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  ServerCliExecutableImportError,
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
} from "./cliErrors.ts";

export class ServerCliPublishIconSourceMissingError extends Schema.TaggedError<ServerCliPublishIconSourceMissingError>()(
  "ServerCliPublishIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon source: ${this.sourcePath}`;
  }
}

export class ServerCliPublishIconTargetMissingError extends Schema.TaggedError<ServerCliPublishIconTargetMissingError>()(
  "ServerCliPublishIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon target: ${this.targetPath}. Run the build subcommand first.`;
  }
}

interface PackageJson {
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  publishConfig: {
    executableFiles: string[];
  };
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);
const WEB_ASSET_BRANDS = [
  "development",
  "nightly",
  "production",
  "dulli",
] as const satisfies ReadonlyArray<WebAssetBrand>;

// pnpm intentionally normalizes non-bin package files to mode 0644. Mark the
// native monitors explicitly so npm/npx installs can execute them on POSIX.
export const RESOURCE_MONITOR_EXECUTABLE_FILES = [
  "./dist/resource-monitor/darwin-arm64/t3-resource-monitor",
  "./dist/resource-monitor/darwin-x64/t3-resource-monitor",
  "./dist/resource-monitor/linux-x64/t3-resource-monitor",
  "./dist/resource-monitor/win32-x64/t3-resource-monitor.exe",
] as const;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  brand: WebAssetBrand,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    Effect.all({
      original: fs.readFile(icon.targetPath),
      publish: fs.readFile(icon.sourcePath),
    }).pipe(Effect.map((contents) => ({ ...icon, ...contents }))),
  );
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

interface PublishIdentityConfig {
  readonly appVersion: Option.Option<string>;
  readonly packageName: Option.Option<string>;
  readonly repositoryUrl: Option.Option<string>;
}

interface PublishIdentity {
  readonly version: string;
  readonly packageName: string;
  readonly repositoryUrl: string;
}

export function resolvePublishIdentity(
  config: PublishIdentityConfig,
  defaults: PublishIdentity,
): PublishIdentity {
  return {
    version: Option.getOrElse(config.appVersion, () => defaults.version),
    packageName: Option.getOrElse(config.packageName, () => defaults.packageName),
    repositoryUrl: Option.getOrElse(config.repositoryUrl, () => defaults.repositoryUrl),
  };
}

export const createVpPmPublishArgs = (
  config: PublishCommandConfig,
  packageName: string,
): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    packageName,
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.String("app-version").pipe(Flag.optional),
    packageName: Flag.String("package-name").pipe(Flag.optional),
    repositoryUrl: Flag.String("repository-url").pipe(Flag.optional),
    brand: Flag.Literals("brand", WEB_ASSET_BRANDS).pipe(Flag.optional),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packageJsonPath = path.join(serverDir, "package.json");

      // Assert build assets exist
      for (const relPath of [
        "dist/bin.mjs",
        "dist/claude-history-worker.mjs",
        "dist/client/index.html",
      ]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
        }
      }

      yield* Effect.acquireUseRelease(
        // Acquire: resolve publish metadata and read every original before mutation.
        Effect.gen(function* () {
          const identity = resolvePublishIdentity(config, {
            version: serverPackageJson.version,
            packageName: serverPackageJson.name,
            repositoryUrl: serverPackageJson.repository.url,
          });
          const publishBrand = Option.getOrElse(config.brand, () =>
            resolveWebAssetBrandForPackageVersion(identity.version),
          );
          const workspaceConfig = yield* readWorkspaceConfig();
          const workspaceCatalog = workspaceConfig.catalog ?? {};
          const workspaceOverrides = workspaceConfig.overrides ?? {};
          const pkg: PackageJson = {
            name: identity.packageName,
            repository: {
              ...serverPackageJson.repository,
              url: identity.repositoryUrl,
            },
            bin: serverPackageJson.bin,
            type: serverPackageJson.type,
            version: identity.version,
            engines: serverPackageJson.engines,
            files: serverPackageJson.files,
            publishConfig: {
              executableFiles: [...RESOURCE_MONITOR_EXECUTABLE_FILES],
            },
            dependencies: resolveCatalogDependencies(
              serverPackageJson.dependencies,
              workspaceCatalog,
              "apps/server",
            ),
            overrides: resolveCatalogDependencies(
              workspaceOverrides,
              workspaceCatalog,
              "apps/server",
            ),
          };

          return {
            packageName: identity.packageName,
            packageJsonString: yield* encodePackageJson(pkg),
            originalPackageJson: yield* fs.readFile(packageJsonPath),
            icons: yield* preparePublishIcons(repoRoot, serverDir, publishBrand),
          };
        }),
        // Use: pnpm publish from the workspace root so pnpm-only workspace
        // config, including override selectors, is interpreted correctly.
        (resource) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(packageJsonPath, `${resource.packageJsonString}\n`);
            for (const icon of resource.icons) {
              yield* fs.writeFile(icon.targetPath, icon.publish);
            }
            yield* Effect.log("[cli] Applied package metadata and publish icon overrides");

            const args = createVpPmPublishArgs(config, resource.packageName);
            const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);

            yield* Effect.log(`[cli] Running: vp pm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );
          }),
        // Release: restore every file even if applying overrides or publishing fails.
        (resource) =>
          Effect.gen(function* () {
            yield* fs.writeFile(packageJsonPath, resource.originalPackageJson);
            for (const icon of resource.icons) {
              yield* fs.writeFile(icon.targetPath, icon.original);
            }
            if (config.verbose) yield* Effect.log("[cli] Restored original publish assets");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            T3CODE_PACK_EXE: "1",
            ...Option.match(config.target, {
              onNone: () => ({}),
              onSome: (target) => ({ T3CODE_PACK_EXE_TARGET: target }),
            }),
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // The executable can only `import` built-ins. A file-backed import
      // passes the bundler and `node dist/bin.mjs`, then throws inside the
      // binary, so read the emitted module graph rather than trusting config.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    "Build the server as a Node single-executable (needs a Node 25.7+ host for --build-sea). The binary still resolves native packages from a node_modules tree beside it.",
  ),
);

/**
 * Publishes the tarballs scripts/build-npm-platform-packages.ts produced:
 * every `@t3code/t3-<platform>.tgz` first, `t3.tgz` (the launcher) last, so
 * the launcher is never installable before the executables it depends on.
 * Tarballs rather than directories because `npm publish <dir>` strips the
 * `node_modules/` the executable loads its native addons from.
 */
const publishExeCmd = Command.make(
  "publish-exe",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-platform-packages.ts."),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      // npm runs with cwd set to the packages dir below, so tarball paths are
      // resolved once here rather than joined twice.
      const packagesDir = path.resolve(config.packagesDir);
      const scopeDir = path.join(packagesDir, "@t3code");
      const launcherTarball = path.join(packagesDir, "t3.tgz");
      const platformTarballs = (yield* fs
        .readDirectory(scopeDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry.startsWith("t3-") && entry.endsWith(".tgz"))
        .sort()
        .map((entry) => path.join(scopeDir, entry));
      if (platformTarballs.length === 0) {
        return yield* new ServerCliBuildAssetMissingError({
          assetPath: path.join(scopeDir, "t3-<platform>.tgz"),
        });
      }
      if (!(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");

      for (const tarball of [...platformTarballs, launcherTarball]) {
        const spawnCommand = yield* resolveSpawnCommand("npm", [...args, tarball]);
        yield* Effect.log(`[cli] npm ${args.join(" ")} ${path.basename(tarball)}`);
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: packagesDir,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
            shell: spawnCommand.shell,
          }),
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Publish the @t3code/t3-<platform> tarballs and then the t3 launcher to npm.",
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd, publishExeCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
