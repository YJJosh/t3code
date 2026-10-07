import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  isPiSessionsDaemonMissing,
  readPiSessionsStartCommand,
  startPiSessionsDaemon,
} from "./PiSessionsStart.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const command = [process.execPath, "--experimental-strip-types", "/x/src/daemon-main.ts"];

const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "pi-start-" });
});
const writeStart = (dir: string, value: unknown, mode = 0o600) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${dir}/start.json`, encode(value));
    yield* fs.chmod(`${dir}/start.json`, mode);
  });

it.layer(NodeServices.layer)("pi-sessions start.json", (it) => {
  it.effect("reads a private start.json naming an absolute executable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* home;
      expect(readPiSessionsStartCommand(dir, path)).toBeUndefined();
      yield* writeStart(dir, { version: 1, command });
      expect(readPiSessionsStartCommand(dir, path)).toEqual(command);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a start.json others can write, a relative executable or another version", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* home;
      yield* writeStart(dir, { version: 1, command }, 0o620);
      expect(readPiSessionsStartCommand(dir, path)).toBeUndefined();
      yield* writeStart(dir, { version: 1, command: ["node", "daemon-main.ts"] });
      expect(readPiSessionsStartCommand(dir, path)).toBeUndefined();
      yield* writeStart(dir, { version: 2, command });
      expect(readPiSessionsStartCommand(dir, path)).toBeUndefined();
      yield* writeStart(dir, { version: 1, command: [process.execPath, ""] });
      expect(readPiSessionsStartCommand(dir, path)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("recognises a missing daemon only from a socket that is absent or refused", () =>
    Effect.sync(() => {
      expect(isPiSessionsDaemonMissing({ cause: { code: "ENOENT" } })).toBe(true);
      expect(isPiSessionsDaemonMissing({ cause: { code: "ECONNREFUSED" } })).toBe(true);
      expect(isPiSessionsDaemonMissing({ cause: { code: "EACCES" } })).toBe(false);
      expect(isPiSessionsDaemonMissing({ detail: "Incompatible Pi sessions daemon." })).toBe(false);
    }),
  );
});

it.live("does not start anything without start.json, on Windows, or when the start exits", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = yield* home;
    const env = { PI_SESSIONS_HOME: dir };
    expect(yield* startPiSessionsDaemon(env, path, "darwin")).toBe(false);
    yield* writeStart(dir, { version: 1, command: [process.execPath, "-e", "process.exit(1)"] });
    expect(yield* startPiSessionsDaemon(env, path, "win32")).toBe(false);
    const before = yield* Clock.currentTimeMillis;
    expect(yield* startPiSessionsDaemon(env, path, "darwin")).toBe(false);
    // A start that exits without a socket gives up at once, not after the 5 s wait.
    expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(3_000);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
