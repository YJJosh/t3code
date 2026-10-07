// @effect-diagnostics nodeBuiltinImport:off
// The pi-sessions daemon must outlive T3's scopes and T3 itself, so it is started
// with a plain detached Node spawn (like serviceLauncher), not a scoped ChildProcess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { piSessionsHome } from "./PiSessionsSocket.ts";

const START_TIMEOUT_MS = 5_000;

/**
 * The command pi-sessions left in `start.json` to start its daemon again. Only a file owned
 * by this user and not writable by others, naming an absolute executable, is used.
 */
export function readPiSessionsStartCommand(home: string, path: Path.Path): string[] | undefined {
  const file = path.join(home, "start.json");
  try {
    const stat = NodeFS.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) return undefined;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    const value: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const { version, command } = value as { version?: unknown; command?: unknown };
    if (version !== 1 || !Array.isArray(command) || command.length === 0) return undefined;
    if (!command.every((part): part is string => typeof part === "string" && part.length > 0))
      return undefined;
    return path.isAbsolute(command[0]!) ? command : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a connection failure means no daemon is listening (as opposed to a broken one). */
export function isPiSessionsDaemonMissing(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

const socketAnswers = (socketPath: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeoutOption("500 millis"), Effect.map(Option.getOrElse(() => false)));

/** Spawns the daemon detached; returns a check for whether it already exited, or undefined. */
function spawnDaemon(home: string, command: string[], path: Path.Path, env: NodeJS.ProcessEnv) {
  try {
    const log = NodeFS.openSync(path.join(home, "daemon.log"), "a", 0o600);
    try {
      const childEnv: NodeJS.ProcessEnv = { ...env, PI_SESSIONS_HOME: home };
      delete childEnv.PI_SESSIONS_T3_THREAD;
      delete childEnv.PI_SESSIONS_T3_ENVIRONMENT;
      let exited = false;
      const child = NodeChildProcess.spawn(command[0]!, command.slice(1), {
        cwd: home,
        detached: true,
        stdio: ["ignore", log, log],
        env: childEnv,
        windowsHide: true,
      });
      child.once("error", () => (exited = true));
      child.once("exit", () => (exited = true));
      child.unref();
      return () => exited;
    } finally {
      NodeFS.closeSync(log);
    }
  } catch {
    return undefined;
  }
}

/**
 * Starts the pi-sessions daemon from its `start.json` when none answers, so a shared chat can
 * open before any terminal ran `pi`. False without the file or when the start fails. Two
 * concurrent starts are harmless: the daemon's lock lets only one run.
 */
export const startPiSessionsDaemon = Effect.fn(function* (
  env: NodeJS.ProcessEnv,
  path: Path.Path,
  platform: NodeJS.Platform,
) {
  if (platform === "win32") return false;
  const home = piSessionsHome(env, path);
  const command = readPiSessionsStartCommand(home, path);
  if (!command) return false;
  const exited = spawnDaemon(home, command, path, env);
  if (!exited) return false;
  const socketPath = path.join(home, "daemon.sock");
  const deadline = (yield* Clock.currentTimeMillis) + START_TIMEOUT_MS;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if (yield* socketAnswers(socketPath)) return true;
    // It exits at once when another daemon won the lock; that daemon may answer now.
    if (exited()) return yield* socketAnswers(socketPath);
    yield* Effect.sleep("100 millis");
  }
  return false;
});
