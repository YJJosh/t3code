// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { WorklerLibrary } from "../WorklerWorkspaceService.ts";

// In-process stand-in for the `workler` library used by tests: it reproduces
// the observable behavior T3 relies on (ordinary local clones under
// `<root>/.worktrees/<name>`, branch/base/checkout plans, dirty-workspace
// guard on removal) without requiring the package to be installed.

const WORKSPACES_DIR = ".worktrees";
const MAIN_WORKSPACE_NAME = "main";

class FakeWorklerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function git(cwd: string | null, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...(cwd ? ["-C", cwd] : []), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitMaybe(cwd: string, args: readonly string[]): string | undefined {
  try {
    const output = git(cwd, args);
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function revParseCommit(repo: string, ref: string): string | undefined {
  return gitMaybe(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function localBranchExists(repo: string, branch: string): boolean {
  return gitMaybe(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== undefined;
}

function isClean(repo: string): boolean {
  return gitMaybe(repo, ["status", "--porcelain"]) === undefined;
}

export function makeFakeWorklerLibrary(): WorklerLibrary {
  const inspectProject: WorklerLibrary["inspectProject"] = (rootInput) => {
    const root = NodePath.resolve(rootInput);
    const exists = NodeFS.existsSync(root);
    const gitRepo = exists && gitMaybe(root, ["rev-parse", "--show-toplevel"]) === root;
    const marked = gitRepo && gitMaybe(root, ["config", "--get", "workler.name"]) !== undefined;
    const configFileExists = NodeFS.existsSync(NodePath.join(root, ".workler"));
    const workspacesDirExists = NodeFS.existsSync(NodePath.join(root, WORKSPACES_DIR));
    return {
      root,
      exists,
      gitRepo,
      marked,
      configFileExists,
      workspacesDirExists,
      initialized: marked || configFileExists,
    };
  };

  const initProject: WorklerLibrary["initProject"] = (rootInput) => {
    const root = NodePath.resolve(rootInput);
    if (!NodeFS.existsSync(root)) {
      throw new FakeWorklerError("ROOT_NOT_FOUND", `project root does not exist: ${root}`);
    }
    const configPath = NodePath.join(root, ".workler");
    const configCreated = !NodeFS.existsSync(configPath);
    if (configCreated) {
      NodeFS.writeFileSync(configPath, "# Workler local workspace rules\n");
    }
    const workspacesPath = NodePath.join(root, WORKSPACES_DIR);
    NodeFS.mkdirSync(workspacesPath, { recursive: true });
    git(root, ["config", "workler.root", root]);
    git(root, ["config", "workler.name", MAIN_WORKSPACE_NAME]);
    return { root, configPath, configCreated, workspacesPath, gitRepo: true };
  };

  const createWorkspace: WorklerLibrary["createWorkspace"] = (rootInput, options) => {
    const root = NodePath.resolve(rootInput);
    if (!inspectProject(root).initialized) {
      throw new FakeWorklerError("NOT_INITIALIZED", `not a workler project: ${root}`);
    }
    const target = NodePath.join(root, WORKSPACES_DIR, options.name);
    if (NodeFS.existsSync(target)) {
      throw new FakeWorklerError("WORKSPACE_EXISTS", `workspace already exists: ${target}`);
    }

    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    git(null, ["clone", "--local", root, target]);

    const branch = options.branch ?? (options.checkout === undefined ? options.name : undefined);
    if (branch !== undefined && options.base !== undefined) {
      if (localBranchExists(root, branch)) {
        throw new FakeWorklerError("BRANCH_EXISTS", `branch "${branch}" already exists`);
      }
      const startPoint =
        revParseCommit(root, `refs/remotes/${options.base}`) ?? revParseCommit(root, options.base);
      if (startPoint === undefined) {
        throw new FakeWorklerError("BAD_REF", `base "${options.base}" is not a valid ref`);
      }
      git(target, ["checkout", "--no-track", "-b", branch, startPoint]);
    } else if (branch !== undefined) {
      if (localBranchExists(target, branch)) {
        git(target, ["checkout", branch]);
      } else if (localBranchExists(root, branch)) {
        git(target, ["checkout", "-b", branch, "--track", `origin/${branch}`]);
      } else {
        git(target, ["checkout", "-b", branch]);
      }
    } else if (options.checkout !== undefined) {
      if (localBranchExists(root, options.checkout)) {
        if (localBranchExists(target, options.checkout)) {
          git(target, ["checkout", options.checkout]);
        } else {
          git(target, [
            "checkout",
            "-b",
            options.checkout,
            "--track",
            `origin/${options.checkout}`,
          ]);
        }
      } else {
        const sha = revParseCommit(root, options.checkout);
        if (sha === undefined) {
          throw new FakeWorklerError("BAD_REF", `--checkout ${options.checkout}: not a valid ref`);
        }
        git(target, ["checkout", "--detach", sha]);
      }
    }

    git(target, ["config", "workler.root", root]);
    git(target, ["config", "workler.name", options.name]);
    const rootOrigin = gitMaybe(root, ["remote", "get-url", "origin"]);
    if (rootOrigin !== undefined) {
      git(target, ["remote", "set-url", "origin", rootOrigin]);
    }

    const abbrev = gitMaybe(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const detached = abbrev === undefined || abbrev === "HEAD";
    return {
      name: options.name,
      path: target,
      root,
      ...(detached || abbrev === undefined ? {} : { branch: abbrev }),
      ...(gitMaybe(target, ["rev-parse", "HEAD"]) !== undefined
        ? { head: gitMaybe(target, ["rev-parse", "HEAD"]) as string }
        : {}),
      detached,
      rules: { ruleCount: 0, results: [], conflicts: 0 },
    };
  };

  const listWorkspaces: WorklerLibrary["listWorkspaces"] = (rootInput) => {
    const root = NodePath.resolve(rootInput);
    if (!inspectProject(root).initialized) {
      throw new FakeWorklerError("NOT_INITIALIZED", `not a workler project: ${root}`);
    }
    const workspacesPath = NodePath.join(root, WORKSPACES_DIR);
    const entries = NodeFS.existsSync(workspacesPath)
      ? NodeFS.readdirSync(workspacesPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .toSorted()
      : [];

    const main = {
      name: MAIN_WORKSPACE_NAME,
      path: root,
      isMain: true,
      isClone: true,
      detached: false,
      ...(gitMaybe(root, ["rev-parse", "--abbrev-ref", "HEAD"]) !== undefined
        ? { branch: gitMaybe(root, ["rev-parse", "--abbrev-ref", "HEAD"]) as string }
        : {}),
    };

    return [
      main,
      ...entries.map((name) => {
        const workspacePath = NodePath.join(workspacesPath, name);
        const isClone = NodeFS.existsSync(NodePath.join(workspacePath, ".git"));
        if (!isClone) {
          return {
            name,
            path: workspacePath,
            isMain: false,
            isClone,
            broken: "not a git clone",
            detached: false,
          };
        }
        const abbrev = gitMaybe(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const detached = abbrev === undefined || abbrev === "HEAD";
        return {
          name,
          path: workspacePath,
          isMain: false,
          isClone,
          ...(detached || abbrev === undefined ? {} : { branch: abbrev }),
          detached,
          clean: isClean(workspacePath),
        };
      }),
    ];
  };

  const removeWorkspace: WorklerLibrary["removeWorkspace"] = (rootInput, name, options = {}) => {
    const root = NodePath.resolve(rootInput);
    if (name === MAIN_WORKSPACE_NAME) {
      throw new FakeWorklerError("MAIN_WORKSPACE", "refusing to remove main workspace");
    }
    const workspacePath = NodePath.join(root, WORKSPACES_DIR, name);
    if (!NodeFS.existsSync(workspacePath)) {
      throw new FakeWorklerError("WORKSPACE_NOT_FOUND", `no workspace named ${name}`);
    }
    if (options.force !== true && !isClean(workspacePath)) {
      throw new FakeWorklerError(
        "WORKSPACE_DIRTY",
        `workspace has local changes: ${workspacePath}`,
      );
    }
    NodeFS.rmSync(workspacePath, { recursive: true, force: true });
    return { name, path: workspacePath };
  };

  return { initProject, inspectProject, createWorkspace, listWorkspaces, removeWorkspace };
}
