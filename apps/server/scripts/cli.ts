#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  brandDulliClientText,
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
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";

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
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

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

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.StandardCommand,
  errorArgs: ReadonlyArray<string> = command.args,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: errorArgs,
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

const DULLI_BRANDABLE_CLIENT_FILE_PATTERN = /\.(?:html|js|json|css|map)$/u;

const preparePublishClientBrand = Effect.fn("preparePublishClientBrand")(function* (
  serverDir: string,
  brand: WebAssetBrand,
) {
  if (brand !== "dulli") return [];

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const pendingDirectories = [path.join(serverDir, "dist/client")];
  const files: Array<{ path: string; original: string; publish: string }> = [];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) continue;
    for (const entry of yield* fs.readDirectory(directory)) {
      const filePath = path.join(directory, entry);
      const stat = yield* fs.stat(filePath);
      if (stat.type === "Directory") {
        pendingDirectories.push(filePath);
        continue;
      }
      if (stat.type !== "File" || !DULLI_BRANDABLE_CLIENT_FILE_PATTERN.test(entry)) continue;

      const original = yield* fs.readFileString(filePath);
      const publish = brandDulliClientText(original);
      if (publish !== original) files.push({ path: filePath, original, publish });
    }
  }

  return files;
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
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
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

const WEB_ASSET_BRANDS = [
  "development",
  "nightly",
  "production",
  "dulli",
] as const satisfies ReadonlyArray<WebAssetBrand>;

export interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
  readonly otp: Option.Option<string>;
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
  if (Option.isSome(config.otp)) args.push("--otp", config.otp.value);

  return args;
};

export function redactOtpArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === "--otp") return "***";
    if (arg.startsWith("--otp=")) return "--otp=***";
    return arg;
  });
}

export function resolvePublishIdentity(
  config: {
    readonly appVersion: Option.Option<string>;
    readonly packageName: Option.Option<string>;
    readonly repositoryUrl: Option.Option<string>;
  },
  defaults: {
    readonly version: string;
    readonly packageName: string;
    readonly repositoryUrl: string;
  },
) {
  return {
    version: Option.getOrElse(config.appVersion, () => defaults.version),
    packageName: Option.getOrElse(config.packageName, () => defaults.packageName),
    repositoryUrl: Option.getOrElse(config.repositoryUrl, () => defaults.repositoryUrl),
  };
}

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    packageName: Flag.string("package-name").pipe(Flag.optional),
    repositoryUrl: Flag.string("repository-url").pipe(Flag.optional),
    brand: Flag.choice("brand", WEB_ASSET_BRANDS).pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    otp: Flag.string("otp").pipe(Flag.optional),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
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
        "dist/service-launcher.mjs",
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
            clientBrandFiles: yield* preparePublishClientBrand(serverDir, publishBrand),
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
            for (const file of resource.clientBrandFiles) {
              yield* fs.writeFileString(file.path, file.publish);
            }
            yield* Effect.log("[cli] Applied package metadata and client branding");

            const args = createVpPmPublishArgs(config, resource.packageName);
            const safeArgs = redactOtpArgs(args);
            const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);

            yield* Effect.log(`[cli] Running: vp pm ${safeArgs.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                // pnpm prompts for npm 2FA (OTP or web auth) on publish; it
                // needs the parent terminal to do so.
                stdin: "inherit",
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
              ["pm", ...safeArgs],
            );
          }),
        // Release: restore every file even if applying overrides or publishing fails.
        (resource) =>
          Effect.gen(function* () {
            yield* fs.writeFile(packageJsonPath, resource.originalPackageJson);
            for (const icon of resource.icons) {
              yield* fs.writeFile(icon.targetPath, icon.original);
            }
            for (const file of resource.clientBrandFiles) {
              yield* fs.writeFileString(file.path, file.original);
            }
            if (config.verbose) yield* Effect.log("[cli] Restored original publish assets");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
