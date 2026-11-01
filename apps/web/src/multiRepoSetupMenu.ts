import type { ContextMenuItem, EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  deriveMultiRepoKey,
  listMultiRepoProjectsToSetUp,
} from "@t3tools/client-runtime/state/project-grouping";
import type { CommandPaletteMultiRepoSetup } from "./commandPaletteBus";

/** Build only when a project menu opens, using the same missing-project rule as Add Project. */
export function buildMultiRepoProjectSetupMenu(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
    readonly serverConfig?: {
      readonly environment: {
        readonly capabilities: {
          readonly multiRepoProjects?: boolean;
          readonly projectCloneTracking?: boolean;
        };
      };
    } | null;
  }>;
}) {
  const projectKeys = new Set(
    input.projects
      .filter((project) =>
        input.projectRefs.some(
          (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
        ),
      )
      .flatMap((project) => {
        const key = deriveMultiRepoKey(project.multiRepo);
        return key === null ? [] : [key];
      }),
  );
  const setupsByAction = new Map<string, CommandPaletteMultiRepoSetup>();
  const items: ContextMenuItem[] = [];
  if (projectKeys.size === 0) return { items, setupsByAction };
  for (const environment of input.environments) {
    const capabilities = environment.serverConfig?.environment.capabilities;
    if (
      environment.connection.phase !== "connected" ||
      capabilities?.multiRepoProjects !== true ||
      capabilities.projectCloneTracking !== true
    ) {
      continue;
    }
    const setup = listMultiRepoProjectsToSetUp(input.projects, environment.environmentId).find(
      (candidate) => projectKeys.has(candidate.key),
    );
    if (!setup) continue;
    const id = `multi-repo-setup:${environment.environmentId}`;
    setupsByAction.set(id, { environmentId: environment.environmentId, setup });
    items.push({ id, label: `Set up on ${environment.label}`, icon: "folder" });
  }
  return {
    items:
      items.length > 1
        ? [
            {
              id: "multi-repo-setup:submenu",
              label: "Set up on...",
              icon: "folder",
              children: items,
            },
          ]
        : items,
    setupsByAction,
  };
}
