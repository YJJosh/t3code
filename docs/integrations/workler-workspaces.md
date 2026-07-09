# Workler Workspaces

T3 Code creates isolated thread workspaces with Workler (the `workler` npm package), a local workspace manager. Instead of `git worktree add`, each new isolated workspace is an ordinary local Git clone under the repository's `.worktrees/<name>` directory, with the repository's `.workler` rules (linked or copied untracked files such as `node_modules` or `.env`) applied automatically.

## Behavior

- **Placement** — new workspaces live at `<repo>/.worktrees/<name>`. The workspace directory name is a filesystem-safe form of the requested branch (`feature/login` → `feature-login`), deduplicated with a numeric suffix when needed. The requested Git branch keeps its original spelling; Workler's separate `base` + `branch` options make that split possible.
- **Base ref** — the workspace branch starts from the requested base. When the "start new workspaces from origin" setting is enabled, the base is the freshly fetched remote commit, and the workspace's remote-tracking ref for the base branch is pinned to it so ahead/behind counts are accurate from the start.
- **Project metadata** — the repository is initialized as a Workler project on first use (idempotent; it creates `.workler` if missing, excludes `.worktrees/` from Git, and marks the repo with `workler.*` config).
- **Legacy Git worktrees** — pre-existing `git worktree` checkouts remain fully supported. They stay visible in branch listings, threads keep running in them, and removal uses the safe `git worktree remove` path. They are never converted or deleted automatically.
- **Removal** — removing an isolated workspace first checks whether the target is a registered Git worktree (removed via Git) or a Workler workspace (removed via the Workler API, which refuses to delete dirty workspaces unless forced). Paths that are neither are refused.
- **Persistence** — thread records keep the historical `worktreePath` field name; only the mechanism behind it changed.

## Server integration

The server talks to Workler exclusively through its programmatic library API (no CLI output parsing), wrapped in `apps/server/src/vcs/WorklerWorkspaceService.ts` — an Effect service with typed `WorklerWorkspaceError`s and an injectable library seam for tests (`apps/server/src/vcs/testing/FakeWorklerLibrary.ts`).

## Dependency status

The `workler` package on npm does not yet publish the programmatic API (`initProject`, `createWorkspace`, `listWorkspaces`, `removeWorkspace`, …). Until a release ships it:

- the server resolves `workler` lazily from the runtime module graph (`import("workler")`) and fails workspace operations with a typed `LIBRARY_UNAVAILABLE` error when it is absent;
- the ambient type declarations live in `apps/server/src/vcs/workler.d.ts`.

**Follow-up once the API is published:** add `workler` to `apps/server/package.json` dependencies (regenerating the lockfile) and delete `apps/server/src/vcs/workler.d.ts` in favor of the package's own types. During development, `npm link`/`pnpm link` the local Workler checkout into the server package instead of referencing local paths in manifests.
