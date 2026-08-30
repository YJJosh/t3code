/**
 * Filesystem locations of the Pi coding agent's configuration.
 *
 * @module provider/pi/piPaths
 */
import type * as Path from "effect/Path";

export interface ResolvePiAgentDirOptions {
  readonly agentDir?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

/**
 * Resolve the Pi agent directory (`~/.pi/agent` by default), honoring an
 * explicit override with `~` expansion against the provided environment's
 * home directory.
 */
export function resolvePiAgentDir(
  paths: Path.Path,
  options: ResolvePiAgentDirOptions = {},
): string {
  const environment = options.environment ?? process.env;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    ".";
  const configuredAgentDir = options.agentDir?.trim();
  if (!configuredAgentDir) {
    return paths.join(home, ".pi", "agent");
  }
  if (configuredAgentDir === "~") {
    return home;
  }
  if (configuredAgentDir.startsWith("~/") || configuredAgentDir.startsWith("~\\")) {
    return paths.join(home, configuredAgentDir.slice(2));
  }
  return configuredAgentDir;
}
