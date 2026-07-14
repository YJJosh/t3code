import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
} from "@t3tools/contracts";
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
import { readThreadShell, useProjects, useServerConfigs, useThread } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  resolveNewDraftStartFromOrigin,
  resolveNewWorktreeDefaultBranch,
} from "../lib/chatThreadActions";
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
  const serverConfigs = useServerConfigs();
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
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const environmentSettings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
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
      const initialEnvMode = options?.envMode ?? environmentSettings.defaultThreadEnvMode;
      const shouldApplyNewWorkspaceDefaults = initialEnvMode === "worktree";
      const shouldStartFromDefaultBranch =
        environmentSettings.newWorktreesStartFromDefaultBranch && shouldApplyNewWorkspaceDefaults;
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
      const startFromOriginOption = shouldApplyNewWorkspaceDefaults
        ? resolveNewDraftStartFromOrigin({
            envMode: initialEnvMode,
            newWorktreesStartFromOrigin: environmentSettings.newWorktreesStartFromOrigin,
          })
        : options?.startFromOrigin;
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
          if (options !== undefined || shouldApplyNewWorkspaceDefaults) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              branch: branchOption ?? null,
              worktreePath: worktreePathOption ?? null,
              envMode: initialEnvMode,
              startFromOrigin:
                startFromOriginOption ??
                resolveNewDraftStartFromOrigin({
                  envMode: initialEnvMode,
                  newWorktreesStartFromOrigin: environmentSettings.newWorktreesStartFromOrigin,
                }),
            });
          }
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
            },
          );
          if (
            currentRouteTarget?.kind !== "draft" ||
            currentRouteTarget.draftId !== reusableStoredDraftThread.draftId
          ) {
            await router.navigate({
              to: "/draft/$draftId",
              params: { draftId: reusableStoredDraftThread.draftId },
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
          startFromOrigin:
            startFromOriginOption ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: environmentSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
        await resolveAndApplyDefaultBranch(draftId);
      })();
    },
    [getCurrentRouteTarget, listRefs, projectGroupingSettings, projects, router, serverConfigs],
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
