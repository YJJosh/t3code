import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<string>>,
      position: { x: number; y: number },
    ) => Promise<string | null>
  >(),
  // REVIEW: the header menu now builds the same multi-repo setup items as the sidebar.
  setupMenu: {
    items: [] as ReadonlyArray<ContextMenuItem<string>>,
    setupsByAction: new Map<string, unknown>(),
  },
  setupOpenedWith: null as unknown,
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "primary",
  readEnvironments: () => [],
}));
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: (detail: unknown) => {
    state.setupOpenedWith = detail;
    recordEffect("multi-repo-setup");
  },
}));
vi.mock("../multiRepoSetupMenu", () => ({
  buildMultiRepoProjectSetupMenu: () => state.setupMenu,
  isMultiRepoSetupMenuId: (id: string | null) => id?.startsWith("multi-repo-setup:") === true,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  canTurnThreadIntoProject: () => false,
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = (options: { readonly onFind?: (threadRef: typeof target) => void } = {}) =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    onFind: options.onFind,
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
  state.setupMenu = { items: [], setupsByAction: new Map() };
  state.setupOpenedWith = null;
});

describe("thread menu permissions", () => {
  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );

  it("offers find only to a header that can open it, without task permission", async () => {
    createMenu().openMenu(position);
    expect(state.show.mock.calls[0]![0].some((item) => item.id === "find")).toBe(false);
    state.show.mockResolvedValue("find");
    const onFind = vi.fn(() => recordEffect("find"));
    createMenu({ onFind }).openMenu(position);
    await state.completed.promise;
    const items = state.show.mock.calls[1]![0];
    expect(items[0]).toMatchObject({ id: "find", label: "Find in thread" });
    expect(items[0]?.disabled).not.toBe(true);
    expect(state.effects).toEqual(["find"]);
    expect(onFind).toHaveBeenCalledExactlyOnceWith(target);
  });

  // REVIEW: covers the header menu offering multi-repo setup like the sidebar's.
  it("offers multi-repo setup after Project settings and opens it in the palette", async () => {
    const intent = { environmentId: EnvironmentId.make("primary"), setup: { key: "k" } };
    state.setupMenu = {
      items: [{ id: "multi-repo-setup:primary", label: "Set up on Primary", icon: "folder" }],
      setupsByAction: new Map([["multi-repo-setup:primary", intent]]),
    };
    state.show.mockResolvedValue("multi-repo-setup:primary");
    createMenu().openMenu(position);
    await state.completed.promise;
    const ids = state.show.mock.calls[0]![0].map((item) => item.id);
    expect(ids.indexOf("multi-repo-setup:primary")).toBe(ids.indexOf("project-settings") + 1);
    expect(state.effects).toEqual(["multi-repo-setup"]);
    expect(state.setupOpenedWith).toEqual({ multiRepoSetup: intent });
  });
});
