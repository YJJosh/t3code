import { createBackgroundTerminalEnvironmentAtoms } from "@t3tools/client-runtime/state/background-terminals";

import { connectionAtomRuntime } from "../connection/runtime";

export const backgroundTerminalEnvironment =
  createBackgroundTerminalEnvironmentAtoms(connectionAtomRuntime);
