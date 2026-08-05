import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DEFAULT_RUNTIME_MODE, type ScopedProjectRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readThreadShell, useProjects, useThread } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  resolveNewDraftStartFromOrigin,
  resolveNewWorktreeDefaultBranch,
} from "../lib/chatThreadActions";
import { waitForPrimaryServerConfig } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

const DEFAULT_BRANCH_LOOKUP_TIMEOUT_MS = 1_000;
const DEFAULT_BRANCH_FALLBACK = "main";

async function withDefaultBranchLookupTimeout<A>(operation: Promise<A>): Promise<A | null> {
  let timeoutId: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(null), DEFAULT_BRANCH_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  });
}

export function useNewThreadHandler() {
  const projects = useProjects();
  // New-thread defaults are a user preference, and the settings UI only ever
  // edits the primary environment's settings.json. Reading the target
  // environment's own settings here would silently reset remote projects to
  // the decoded defaults ("local" mode, current branch), since nothing can
  // set those values on a remote server.
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const listRefs = useAtomCommand(vcsEnvironment.listRefsOnce, {
    label: "resolve new workspace default branch",
    reportFailure: false,
  });
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        replace?: boolean;
      },
    ): Promise<void> => {
      // The shell/project snapshot can arrive before the primary server config
      // on a cold connection. Pause every entry point until the user's real
      // workspace settings arrive instead of rejecting or baking schema
      // defaults into a persistent draft.
      const primaryServerSettings = (await waitForPrimaryServerConfig()).settings;

      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's *working mode* from the thread being
      // viewed: model (including options like reasoning effort and context
      // window), permission mode, and interaction mode. Branch, worktree, and
      // env mode never carry implicitly — those come from the configured
      // defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryRuntimeMode =
        carrySourceComposer?.runtimeMode ??
        carrySourceShell?.runtimeMode ??
        carrySourceDraft?.runtimeMode ??
        null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread;
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const initialEnvMode = options?.envMode ?? primaryServerSettings.defaultThreadEnvMode;
      const shouldApplyNewWorkspaceDefaults = initialEnvMode === "worktree";
      const shouldStartFromDefaultBranch =
        primaryServerSettings.newWorktreesStartFromDefaultBranch && shouldApplyNewWorkspaceDefaults;
      const provisionalDefaultBranch = shouldStartFromDefaultBranch
        ? DEFAULT_BRANCH_FALLBACK
        : null;
      const branchOption = shouldStartFromDefaultBranch
        ? provisionalDefaultBranch
        : options?.branch;
      const resolveAndApplyDefaultBranch = async (draftId: DraftId) => {
        if (!shouldStartFromDefaultBranch || !project || provisionalDefaultBranch === null) {
          return;
        }
        const refsResult = await withDefaultBranchLookupTimeout(
          listRefs({
            environmentId: projectRef.environmentId,
            input: { cwd: project.workspaceRoot, limit: 100 },
          }),
        );
        if (refsResult?._tag !== "Success") {
          return;
        }
        const resolvedBranch = resolveNewWorktreeDefaultBranch(refsResult.value.refs);
        if (resolvedBranch === null || resolvedBranch === provisionalDefaultBranch) {
          return;
        }
        const currentDraft = getDraftSession(draftId);
        if (
          currentDraft?.envMode === "worktree" &&
          currentDraft.worktreePath === null &&
          currentDraft.branch === provisionalDefaultBranch &&
          currentDraft.promotedTo === null
        ) {
          setDraftThreadContext(draftId, { branch: resolvedBranch });
        }
      };
      const worktreePathOption = shouldStartFromDefaultBranch ? null : options?.worktreePath;
      // A new worktree always takes the configured start-from-origin default;
      // other modes honor an explicit option before falling back to it.
      const explicitStartFromOrigin = shouldApplyNewWorkspaceDefaults
        ? undefined
        : options?.startFromOrigin;
      const resolvedStartFromOrigin =
        explicitStartFromOrigin ??
        resolveNewDraftStartFromOrigin({
          envMode: initialEnvMode,
          newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
        });
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (reusableStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Resurrecting a stored draft must not resurrect its stale context:
          // explicit workspace options win outright; otherwise the env context
          // resets to the configured defaults so drafts seeded before a
          // defaults change (or by the old carry-over behavior) stop landing
          // on "current checkout" branches forever. Composer text is
          // preserved. When the draft is already open and no options were
          // passed, leave it alone entirely — the user may have just picked a
          // branch in the composer.
          // A worktree draft that starts from the default branch seeds the
          // provisional fallback here and resolves the real default branch
          // asynchronously below, so those writes win over the raw options.
          const workspaceContext = hasExplicitWorkspaceOption
            ? {
                ...(hasBranchOption || shouldStartFromDefaultBranch
                  ? { branch: branchOption ?? null }
                  : {}),
                ...(hasWorktreePathOption || shouldStartFromDefaultBranch
                  ? { worktreePath: worktreePathOption ?? null }
                  : {}),
                ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
                ...(hasStartFromOriginOption || shouldApplyNewWorkspaceDefaults
                  ? { startFromOrigin: resolvedStartFromOrigin }
                  : {}),
              }
            : isDraftAlreadyOpen
              ? null
              : {
                  branch: branchOption ?? null,
                  worktreePath: worktreePathOption ?? null,
                  envMode: initialEnvMode,
                  startFromOrigin: resolvedStartFromOrigin,
                };
          if (workspaceContext) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
            if (carryModelSelection) {
              // The carried selection is a complete snapshot of the viewed
              // thread's model state: absent options mean "no options", not
              // "keep the stale draft's options".
              setModelSelection(reusableStoredDraftThread.draftId, carryModelSelection, {
                replaceOptions: true,
              });
            }
          }
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
              ...(workspaceContext ?? {}),
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          if (
            currentRouteTarget?.kind !== "draft" ||
            currentRouteTarget.draftId !== reusableStoredDraftThread.draftId
          ) {
            await router.navigate({
              to: "/draft/$draftId",
              params: { draftId: reusableStoredDraftThread.draftId },
              replace: options?.replace ?? false,
            });
          }
          await resolveAndApplyDefaultBranch(reusableStoredDraftThread.draftId);
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        // The active blank draft is already this project's new thread. Keep
        // its per-chat choices instead of re-seeding it from the prior context.
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: branchOption ?? null,
          worktreePath: worktreePathOption ?? null,
          envMode: initialEnvMode,
          startFromOrigin: resolvedStartFromOrigin,
          runtimeMode: carryRuntimeMode ?? DEFAULT_RUNTIME_MODE,
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        applyStickyState(draftId);
        if (carryModelSelection) {
          // After sticky state so the viewed thread's exact selection
          // (model + options like effort and context window) wins over the
          // globally sticky one. replaceOptions: the carried selection is a
          // complete snapshot — absent options mean "no options", not "keep
          // whatever sticky state just wrote".
          setModelSelection(draftId, carryModelSelection, { replaceOptions: true });
        }

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        await resolveAndApplyDefaultBranch(draftId);
      })();
    },
    [getCurrentRouteTarget, listRefs, projectGroupingSettings, projects, router],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
