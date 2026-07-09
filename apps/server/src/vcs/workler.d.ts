// Ambient declaration for the `workler` programmatic API. The published
// package does not ship the library entry point yet, so the dependency cannot
// be added to package.json without breaking install reproducibility; the
// server loads the module lazily at runtime instead (see
// WorklerWorkspaceService.ts). Delete this file and add `workler` to the
// apps/server dependencies once a release ships these exports with types.
declare module "workler" {
  export type WorklerErrorCode =
    | "ROOT_NOT_FOUND"
    | "NOT_INITIALIZED"
    | "NOT_A_GIT_REPO"
    | "INVALID_NAME"
    | "INVALID_OPTIONS"
    | "WORKSPACE_EXISTS"
    | "WORKSPACE_NOT_FOUND"
    | "MAIN_WORKSPACE"
    | "WORKSPACE_DIRTY"
    | "BRANCH_EXISTS"
    | "BAD_REF"
    | "CONFIG_INVALID"
    | "RULE_CONFLICT"
    | "SETUP_FAILED"
    | "LOCKED";

  export class WorklerError extends Error {
    readonly code: WorklerErrorCode;
    readonly details?: Record<string, unknown>;
  }

  export interface ProjectInfo {
    root: string;
    exists: boolean;
    gitRepo: boolean;
    marked: boolean;
    configFileExists: boolean;
    workspacesDirExists: boolean;
    initialized: boolean;
    parent?: string;
  }

  export interface InitResult {
    root: string;
    configPath: string;
    configCreated: boolean;
    workspacesPath: string;
    gitRepo: boolean;
    excludePath?: string;
    gitignorePath?: string;
  }

  export interface CreateWorkspaceOptions {
    name: string;
    base?: string;
    branch?: string;
    checkout?: string;
    force?: boolean;
    onProgress?: (message: string) => void;
  }

  export interface CreateWorkspaceResult {
    name: string;
    path: string;
    root: string;
    branch?: string;
    head?: string;
    detached: boolean;
  }

  export interface WorkspaceInfo {
    name: string;
    path: string;
    isMain: boolean;
    isClone: boolean;
    broken?: string;
    branch?: string;
    head?: string;
    shortHead?: string;
    detached: boolean;
    clean?: boolean;
  }

  export interface RemoveWorkspaceOptions {
    force?: boolean;
  }

  export interface RemoveWorkspaceResult {
    name: string;
    path: string;
  }

  export function initProject(root: string): InitResult;
  export function inspectProject(root: string): ProjectInfo;
  export function createWorkspace(
    root: string,
    options: CreateWorkspaceOptions,
  ): CreateWorkspaceResult;
  export function listWorkspaces(root: string): WorkspaceInfo[];
  export function resolveWorkspacePath(root: string, name: string): string;
  export function removeWorkspace(
    root: string,
    name: string,
    options?: RemoveWorkspaceOptions,
  ): RemoveWorkspaceResult;
}
