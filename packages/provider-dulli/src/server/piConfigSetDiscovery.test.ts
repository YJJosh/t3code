import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

import {
  discoverPiConfigSets,
  discoverPiConfigSetProfiles,
  PI_DEFAULT_CONFIG_SET,
  resolvePiSessionConfigSet,
} from "./piConfigSetDiscovery.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-pi-sets-" })
    .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
  const agentDir = paths.join(root, "agent");
  const main = paths.join(root, "sets", "main");
  const dev = paths.join(root, "sets", "dev");
  const registryPath = paths.join(root, "config-sets.json");
  yield* fs.makeDirectory(main, { recursive: true });
  yield* fs.makeDirectory(dev, { recursive: true });
  yield* fs.symlink(main, agentDir);
  yield* fs.writeFileString(paths.join(main, "settings.json"), "{}");
  yield* fs.writeFileString(paths.join(dev, "settings.json"), "{}");
  yield* fs.writeFileString(
    paths.join(main, "profiles.json"),
    json({ profiles: { coder: {}, review: { description: "Main review" } } }),
  );
  yield* fs.writeFileString(
    paths.join(dev, "profiles.json"),
    json({ profiles: { research: {}, review: { description: "Dev review" } } }),
  );
  const registry = json({
    version: 1,
    active: "dev",
    sets: {
      main: { path: main, description: "Main home" },
      dev: { path: dev },
    },
  });
  yield* fs.writeFileString(registryPath, registry);
  const options = { agentDir, environment: { HOME: root } };
  return { fs, paths, root, main, dev, registryPath, registry, options };
});

describe("Pi config set discovery", () => {
  it.effect(
    "uses the resolved agent link, not stale registry.active, and unions set-local profiles",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const discovery = yield* discoverPiConfigSets(f.options);
        expect(discovery.defaultName).toBe("main");
        expect(discovery.sets.map((set) => [set.name, set.available])).toEqual([
          ["dev", true],
          ["main", true],
        ]);
        const profiles = yield* discoverPiConfigSetProfiles(
          { ...f.options, configuredProfile: "coder" },
          discovery,
        );
        expect(profiles).toEqual([
          { id: "coder", label: "coder", isDefault: true },
          { id: "research", label: "research" },
          { id: "review", label: "review", description: "Main review" },
        ]);
        const selected = yield* resolvePiSessionConfigSet(f.options, "dev");
        expect(selected?.directory).toBe(f.dev);
        expect(yield* f.fs.readFileString(f.registryPath)).toBe(f.registry);
        expect(yield* f.fs.realPath(f.options.agentDir)).toBe(f.main);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("hides missing, malformed, unsupported and invalid registries", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.registryPath);
      expect((yield* discoverPiConfigSets(f.options)).sets).toEqual([]);
      for (const contents of [
        "{",
        "null",
        '{"version":2,"sets":{}}',
        '{"sets":{"bad name":{"path":"/tmp/no"}}}',
        '{"sets":{"main":{"path":"relative"}}}',
        '{"sets":{"main":{"path":"/tmp/no","remote":{}}}}',
      ]) {
        yield* f.fs.writeFileString(f.registryPath, contents);
        expect((yield* discoverPiConfigSets(f.options)).sets).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "honors registry/home overrides and rejects inherited selection metadata for scratch homes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const custom = f.paths.join(f.root, "custom.json");
        yield* f.fs.writeFileString(custom, f.registry);
        const pinned = {
          agentDir: f.dev,
          environment: {
            HOME: f.root,
            PI_CONFIG_SET_NAME: "dev",
            PI_CONFIG_SET_DIR: f.dev,
            PI_CONFIG_SET_ROOT: f.root,
            PI_CONFIG_SET_REGISTRY: custom,
          },
        };
        expect((yield* discoverPiConfigSets(pinned)).defaultName).toBe("dev");
        expect(
          (yield* discoverPiConfigSets({
            environment: {
              HOME: f.root,
              PI_CODING_AGENT_DIR: f.dev,
              PI_CONFIG_SET_REGISTRY: custom,
            },
          })).defaultName,
        ).toBe("dev");
        expect(
          (yield* discoverPiConfigSets({
            ...pinned,
            agentDir: f.paths.join(f.root, "scratch", "agent"),
          })).sets,
        ).toEqual([]);
        expect(
          (yield* discoverPiConfigSets({
            ...f.options,
            environment: { HOME: f.root, PI_CONFIG_REPO: "/legacy" },
          })).sets,
        ).toEqual([]);
        yield* f.fs.writeFileString(custom, json({ sets: { dev: { path: "~/sets/dev" } } }));
        expect((yield* discoverPiConfigSets(pinned)).sets[0]?.directory).toBe(f.dev);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves an unregistered explicit provider home as the default", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const discovery = yield* discoverPiConfigSets({
        agentDir: f.root,
        environment: { HOME: f.root, PI_CONFIG_SET_REGISTRY: f.registryPath },
      });
      expect(discovery.defaultName).toBe(PI_DEFAULT_CONFIG_SET);
      expect(yield* resolvePiSessionConfigSet(f.options, PI_DEFAULT_CONFIG_SET)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "lists unavailable remote sets but refuses launch without mounting or running commands",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const mount = f.paths.join(f.root, "mnt", "remote");
        yield* f.fs.makeDirectory(mount, { recursive: true });
        // Even a populated ordinary directory is not an SSHFS mountpoint.
        yield* f.fs.writeFileString(f.paths.join(mount, "settings.json"), "{}");
        yield* f.fs.writeFileString(
          f.registryPath,
          json({
            sets: {
              main: { path: f.main },
              remote: {
                path: f.dev,
                remote: {
                  source: "host:pi-sets/main",
                  mount,
                  mountCommand: ["touch", f.paths.join(f.root, "must-not-exist")],
                },
              },
              missing: {
                path: f.paths.join(f.root, "missing"),
                remote: { source: "host:missing" },
              },
            },
          }),
        );
        const discovery = yield* discoverPiConfigSets(f.options);
        expect(discovery.sets.filter((set) => set.remote).every((set) => !set.available)).toBe(
          true,
        );
        const result = yield* resolvePiSessionConfigSet(f.options, "remote").pipe(Effect.flip);
        expect(result.message).toContain("unmounted");
        expect(yield* f.fs.exists(f.paths.join(f.root, "must-not-exist"))).toBe(false);
        const profiles = yield* discoverPiConfigSetProfiles(f.options, discovery);
        expect(profiles.some((profile) => profile.id === "research")).toBe(false);
        expect(
          (yield* resolvePiSessionConfigSet(f.options, "removed").pipe(Effect.flip)).message,
        ).toContain("no longer registered");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a remote definition backed by an already prepared local shared folder", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.registryPath,
        json({
          sets: {
            dev: { path: f.dev, remote: { source: f.main } },
          },
        }),
      );
      expect((yield* resolvePiSessionConfigSet(f.options, "dev"))?.available).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
