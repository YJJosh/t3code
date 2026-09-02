import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** A lazy, server-local adapter for Workler's workspace library. */
export type WorklerLibrary = Pick<
  typeof import("workler"),
  "createWorkspace" | "listWorkspaces" | "removeWorkspace"
>;

export type WorklerWorkspaceErrorCode =
  | import("workler").WorklerErrorCode
  | "LIBRARY_UNAVAILABLE"
  | "UNEXPECTED";

export class WorklerWorkspaceError extends Data.TaggedError("WorklerWorkspaceError")<{
  readonly operation: string;
  readonly root: string;
  readonly code: WorklerWorkspaceErrorCode;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Workler workspace operation failed in ${this.operation} (${this.root}): ${this.detail}`;
  }
}

export interface WorklerCreateWorkspaceInput {
  readonly root: string;
  readonly name: string;
  readonly base?: string | undefined;
  readonly branch?: string | undefined;
  readonly checkout?: string | undefined;
}

export interface WorklerWorkspaceSummary {
  readonly name: string;
  readonly path: string;
  readonly isMain: boolean;
  readonly isClone: boolean;
  readonly broken: string | null;
  readonly branch: string | null;
}

export interface WorklerCreatedWorkspace {
  readonly name: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
}

export class WorklerWorkspaceService extends Context.Service<
  WorklerWorkspaceService,
  {
    readonly createWorkspace: (
      input: WorklerCreateWorkspaceInput,
    ) => Effect.Effect<WorklerCreatedWorkspace, WorklerWorkspaceError>;
    readonly listWorkspaces: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<WorklerWorkspaceSummary>, WorklerWorkspaceError>;
    readonly removeWorkspace: (input: {
      readonly root: string;
      readonly name: string;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<{ readonly name: string; readonly path: string }, WorklerWorkspaceError>;
  }
>()("t3/vcs/WorklerWorkspaceService") {}

function isWorklerLibraryError(value: unknown): value is Error & { readonly code: string } {
  return value instanceof Error && "code" in value && typeof value.code === "string";
}

function toWorkspaceError(operation: string, root: string, cause: unknown): WorklerWorkspaceError {
  return isWorklerLibraryError(cause)
    ? new WorklerWorkspaceError({
        operation,
        root,
        code: cause.code as WorklerWorkspaceErrorCode,
        detail: cause.message,
        cause,
      })
    : new WorklerWorkspaceError({
        operation,
        root,
        code: "UNEXPECTED",
        detail: "Workler workspace operation failed unexpectedly.",
        cause,
      });
}

export const makeFromLibrary = (
  library: Effect.Effect<WorklerLibrary, WorklerWorkspaceError>,
): WorklerWorkspaceService["Service"] => {
  const withLibrary = <A>(
    operation: string,
    root: string,
    run: (library: WorklerLibrary) => A,
  ): Effect.Effect<A, WorklerWorkspaceError> =>
    library.pipe(
      Effect.mapError(
        (error) =>
          new WorklerWorkspaceError({
            operation,
            root,
            code: error.code,
            detail: error.detail,
            cause: error.cause,
          }),
      ),
      Effect.flatMap((resolved) =>
        Effect.try({
          try: () => run(resolved),
          catch: (cause) => toWorkspaceError(operation, root, cause),
        }),
      ),
    );

  return WorklerWorkspaceService.of({
    createWorkspace: (input) =>
      withLibrary("WorklerWorkspaceService.createWorkspace", input.root, (workler) => {
        const created = workler.createWorkspace(input.root, {
          name: input.name,
          ...(input.base === undefined ? {} : { base: input.base }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.checkout === undefined ? {} : { checkout: input.checkout }),
        });
        return {
          name: created.name,
          path: created.path,
          branch: created.branch ?? null,
          head: created.head ?? null,
          detached: created.detached,
        };
      }),
    listWorkspaces: (root) =>
      withLibrary("WorklerWorkspaceService.listWorkspaces", root, (workler) =>
        workler.listWorkspaces(root).map((workspace) => ({
          name: workspace.name,
          path: workspace.path,
          isMain: workspace.isMain,
          isClone: workspace.isClone,
          broken: workspace.broken ?? null,
          branch: workspace.branch ?? null,
        })),
      ),
    removeWorkspace: (input) =>
      withLibrary("WorklerWorkspaceService.removeWorkspace", input.root, (workler) => {
        const removed = workler.removeWorkspace(
          input.root,
          input.name,
          input.force === undefined ? {} : { force: input.force },
        );
        return { name: removed.name, path: removed.path };
      }),
  });
};

export const make = Effect.gen(function* () {
  const library = yield* Effect.cached(
    Effect.tryPromise({
      try: () => import("workler") as Promise<WorklerLibrary>,
      catch: (cause) =>
        new WorklerWorkspaceError({
          operation: "WorklerWorkspaceService.loadLibrary",
          root: "",
          code: "LIBRARY_UNAVAILABLE",
          detail: "The bundled Workler library could not be loaded by this server install.",
          cause,
        }),
    }),
  );
  return makeFromLibrary(library);
});

export const layer = Layer.effect(WorklerWorkspaceService, make);
export const layerFromLibrary = (library: WorklerLibrary) =>
  Layer.succeed(WorklerWorkspaceService, makeFromLibrary(Effect.succeed(library)));
