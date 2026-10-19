import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  SourceControlProviderError,
  SourceControlRepositoryError,
  type ProjectCloneMember,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";
import { redactGitRemoteUrl } from "@t3tools/shared/git";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isBitbucketRepositoryLocatorError = Schema.is(BitbucketApi.BitbucketRepositoryLocatorError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /** Removes a partial or failed clone so the destination is empty again. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    /**
     * Everything `cloneMultiRepo` checks before running git: the destination
     * is empty, and every member is its own folder inside it.
     */
    readonly prepareMultiRepoClone: (input: {
      readonly destinationPath: string;
      readonly members: ReadonlyArray<ProjectCloneMember>;
    }) => Effect.Effect<SourceControlPreparedMultiRepoClone, SourceControlRepositoryError>;
    /**
     * Clones every member of a multi-repo project in turn, then writes the
     * `.workler` that lists them. Progress details name the member.
     */
    readonly cloneMultiRepo: (
      prepared: SourceControlPreparedMultiRepoClone,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    /** Removes what a partial or failed multi-repo clone left in the destination. */
    readonly discardMultiRepoClone: (
      prepared: SourceControlPreparedMultiRepoClone,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlPreparedMultiRepoClone {
  readonly destinationPath: string;
  readonly members: ReadonlyArray<{
    /** `/`-separated, relative to the destination. */
    readonly path: string;
    /** Credential-free; safe to show and to store in snapshots. */
    readonly remoteUrl: string;
    /** What git is given; may carry embedded credentials. */
    readonly cloneUrl: string;
  }>;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            isSourceControlProviderError(cause) &&
            cause.provider === "bitbucket" &&
            isBitbucketRepositoryLocatorError(cause.cause)
              ? BitbucketApi.BitbucketRepositoryLocatorError.detail
              : "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

/** Drops `user:token@` from any URL embedded in free text. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

const WORKLER_CONFIG_FILE = ".workler";
// Folders Workler manages itself, so they can never be a member.
const RESERVED_MEMBER_FOLDERS = new Set([".git", ".worktrees", WORKLER_CONFIG_FILE]);

/** A member path as Workler accepts it, `/`-separated, or null when it would leave its folder. */
function normalizeMultiRepoMemberPath(raw: string): string | null {
  // `.workler` is one `project <path>` per line with no escapes, so control
  // characters (a newline above all) would leave a broken file behind a finished clone.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw) || /^(?:[a-zA-Z]:|[\\/])/.test(raw)) return null;
  // Workler quotes a path with one kind of quote, so it cannot hold both.
  if (raw.includes('"') && raw.includes("'")) return null;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  if (RESERVED_MEMBER_FOLDERS.has(segments[0]!.toLowerCase())) return null;
  // A repository's own .git folder is never a place for another clone.
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return null;
  return segments.join("/");
}

function memberPathsOverlap(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Quotes a `.workler` path the way Workler writes one. */
function quoteWorklerPath(value: string): string {
  if (!/[\s#"']/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string, ignoredEntries: ReadonlyArray<string> = []) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.some((entry) => !ignoredEntries.includes(entry))) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactGitRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(prepared.destinationPath),
        // `--` keeps a URL starting with `-` from being read as an option. Member
        // URLs of a multi-repo setup come from another environment's `.git/config`.
        args: [
          "clone",
          "--progress",
          "--",
          prepared.cloneUrl,
          path.basename(prepared.destinationPath),
        ],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );

    return {
      cwd: prepared.destinationPath,
      remoteUrl: prepared.remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and must stay;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const prepareMultiRepoClone = Effect.fn("SourceControlRepositoryService.prepareMultiRepoClone")(
    function* (input: {
      readonly destinationPath: string;
      readonly members: ReadonlyArray<ProjectCloneMember>;
    }) {
      const members: Array<SourceControlPreparedMultiRepoClone["members"][number]> = [];
      for (const member of input.members) {
        const memberPath = normalizeMultiRepoMemberPath(member.path);
        if (memberPath === null) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: `'${member.path}' is not a folder inside the project.`,
          });
        }
        const overlap = members.find((existing) => memberPathsOverlap(existing.path, memberPath));
        if (overlap) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: `The repositories '${overlap.path}' and '${memberPath}' would share a folder.`,
          });
        }
        members.push({
          path: memberPath,
          remoteUrl: redactGitRemoteUrl(member.remoteUrl),
          cloneUrl: member.remoteUrl,
        });
      }
      // Members clone into subfolders, so Finder's .DS_Store in a folder made in
      // Finder doesn't get in their way.
      const destination = yield* prepareDestination(input.destinationPath, [".DS_Store"]);
      return {
        destinationPath: destination.destinationPath,
        members,
      } satisfies SourceControlPreparedMultiRepoClone;
    },
  );

  const cloneMultiRepo = Effect.fn("SourceControlRepositoryService.cloneMultiRepo")(function* (
    prepared: SourceControlPreparedMultiRepoClone,
    options?: SourceControlCloneOptions,
  ) {
    for (const [index, member] of prepared.members.entries()) {
      const label = `${member.path} (${index + 1}/${prepared.members.length})`;
      const onProgress = options?.onProgress;
      yield* cloneRepository(
        {
          remoteUrl: member.cloneUrl,
          destinationPath: path.join(prepared.destinationPath, member.path),
        },
        {
          ...options,
          ...(onProgress
            ? {
                onProgress: (line) =>
                  onProgress({
                    ...line,
                    detail: line.detail ? `${label} · ${line.detail}` : label,
                  }),
              }
            : {}),
        },
      ).pipe(
        Effect.mapError((error) =>
          isSourceControlRepositoryError(error)
            ? new SourceControlRepositoryError({
                operation: error.operation,
                provider: error.provider,
                detail: `${member.path}: ${error.detail}`,
                cause: error,
              })
            : error,
        ),
      );
    }
    // Written last: until every member is in place the folder is no group.
    yield* fileSystem
      .writeFileString(
        path.join(prepared.destinationPath, WORKLER_CONFIG_FILE),
        prepared.members.map((member) => `project ${quoteWorklerPath(member.path)}\n`).join(""),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("unknown"),
              detail: "The repositories were cloned, but the .workler file could not be written.",
              cause,
            }),
        ),
      );
  });

  const discardMultiRepoClone = Effect.fn("SourceControlRepositoryService.discardMultiRepoClone")(
    function* (prepared: SourceControlPreparedMultiRepoClone) {
      const root = yield* normalizeDestinationPath(prepared.destinationPath);
      // The destination was empty when the clone started, so the .workler is ours.
      yield* fileSystem.remove(path.join(root, WORKLER_CONFIG_FILE), { force: true });
      // Deepest first, so the folders a nested member needed can go as well.
      const members = prepared.members.toSorted((a, b) => b.path.length - a.path.length);
      for (const member of members) {
        let folder = path.join(root, member.path);
        yield* discardClone(folder);
        while (folder !== root && folder.startsWith(root)) {
          const entries = yield* fileSystem
            .readDirectory(folder)
            .pipe(Effect.orElseSucceed(() => null));
          if (entries !== null && entries.length > 0) break;
          // Empty, so recursive only satisfies `rm` for a directory.
          if (entries !== null) yield* fileSystem.remove(folder, { recursive: true });
          folder = path.dirname(folder);
        }
      }
    },
  );

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    prepareMultiRepoClone: (input) =>
      prepareMultiRepoClone(input).pipe(
        mapRepositoryError("cloneRepository", SourceControlProviderKind.make("unknown")),
      ),
    cloneMultiRepo: (prepared, options) =>
      cloneMultiRepo(prepared, options).pipe(
        mapRepositoryError("cloneRepository", SourceControlProviderKind.make("unknown")),
      ),
    discardMultiRepoClone: (prepared) =>
      discardMultiRepoClone(prepared).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
