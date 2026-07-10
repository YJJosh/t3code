# Workler Workspaces

By default, T3 Code creates isolated thread workspaces with Workler (the `workler` npm package), a local workspace manager. Instead of `git worktree add`, each new isolated workspace is an ordinary local Git clone under the repository's `.worktrees/<name>` directory, with the repository's `.workler` rules (linked or copied untracked files such as `node_modules` or `.env`) applied automatically.

## Behavior

- **Setting** — **Settings → General → Use Workler** is enabled by default. Turning it off makes future isolated workspaces use T3's registered Git-worktree mechanism. It does not hide, convert, or change removal behavior for existing Workler clones or Git worktrees.
- **Placement** — new Workler workspaces live at `<repo>/.worktrees/<name>`. The workspace directory name is a filesystem-safe form of the requested branch (`feature/login` → `feature-login`), deduplicated with a numeric suffix when needed. The requested Git branch keeps its original spelling; Workler's separate `base` + `branch` options make that split possible.
- **Base ref** — the workspace branch starts from the requested base. When the "start new workspaces from origin" setting is enabled, the base is the freshly fetched remote commit, and the workspace's remote-tracking ref for the base branch is pinned to it so ahead/behind counts are accurate from the start.
- **Project metadata** — the repository is initialized as a Workler project on first use (idempotent; it creates `.workler` if missing, excludes `.worktrees/` from Git, and marks the repo with `workler.*` config).
- **Legacy Git worktrees** — pre-existing `git worktree` checkouts remain fully supported. They stay visible in branch listings, threads keep running in them, and removal uses the safe `git worktree remove` path. They are never converted or deleted automatically.
- **Removal** — removing an isolated workspace first checks whether the target is a registered Git worktree (removed via Git) or a Workler workspace (removed via the Workler API, which refuses to delete dirty workspaces unless forced). Paths that are neither are refused.
- **Persistence** — thread records keep the historical `worktreePath` field name; only the mechanism behind it changed.

## Server integration

The server talks to Workler exclusively through its programmatic library API (no CLI output parsing), wrapped in `apps/server/src/vcs/WorklerWorkspaceService.ts` — an Effect service with typed `WorklerWorkspaceError`s and an injectable library seam for tests (`apps/server/src/vcs/testing/FakeWorklerLibrary.ts`).

## Dependency

The server depends on `workler` 0.1.3 or newer, which publishes the typed programmatic API (`initProject`, `createWorkspace`, `listWorkspaces`, `removeWorkspace`, …). The adapter resolves the package lazily on first use and reports a typed `LIBRARY_UNAVAILABLE` error if an installation is missing or corrupt.
