import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ProfilesEditorState,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const fixture = vi.hoisted(() => ({
  folder: "first",
  name: "alpha",
}));

vi.mock("../../state/profiles", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const editor = Atom.make(() =>
    AsyncResult.success({
      folder: fixture.folder,
      exists: true,
      profiles: { profiles: { [fixture.name]: { prompts: [], skills: [] } } },
      providerSettings: {},
      prompts: [],
      skills: [],
      catalog: {
        folder: fixture.folder,
        profiles: { [fixture.name]: { prompts: [], skills: [] } },
      },
      sync: { revision: 1, hash: "h", syncedHash: "h", updatedAt: null },
    } satisfies ProfilesEditorState),
  );
  const detected = Atom.make(AsyncResult.success({}));
  return {
    profilesEnvironment: {
      editor: () => editor,
      detectOptions: () => detected,
      writeEditor: { permissionAtom: () => allowed },
      runSkills: { permissionAtom: () => allowed },
      clearClaudeList: { permissionAtom: () => allowed },
    },
    syncProfilesNow: async () => undefined,
    useProfilesSyncSnapshot: () => ({ running: false, statuses: new Map(), lastRunAt: null }),
  };
});
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const catalog = Atom.make(() =>
    AsyncResult.success({ profiles: { profiles: { [fixture.name]: {} } } }),
  );
  return { serverEnvironment: { profileConfig: () => catalog } };
});
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, profilesFolder: fixture.folder }),
  useUpdateEnvironmentSettings:
    () => (patch: ServerSettingsPatch, options?: { onSaved?: () => void }) => {
      fixture.folder = patch.profilesFolder ?? fixture.folder;
      fixture.name = "beta";
      options?.onSaved?.();
    },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => async () => undefined,
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: async () => false }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: { environmentId: EnvironmentId.make("test") },
    scope: { kind: "all" },
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    title,
    children,
    headerAction,
  }: {
    title: string;
    children: React.ReactNode;
    headerAction?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description?: React.ReactNode;
    control?: React.ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  ),
}));

import { ProfilesSettingsPanel } from "./ProfilesSettings";
import { serverEnvironment } from "../../state/server";

function Page() {
  const catalog = useAtomValue(
    serverEnvironment.profileConfig({ environmentId: EnvironmentId.make("test"), input: {} }),
  );
  return (
    <>
      <ProfilesSettingsPanel />
      <output>
        {catalog._tag === "Success"
          ? Object.keys(catalog.value.profiles?.profiles ?? {}).join(",")
          : "loading"}
      </output>
    </>
  );
}

it("reloads the composer catalog and switches the editor to a newly saved folder", async () => {
  fixture.folder = "first";
  fixture.name = "alpha";
  await using screen = await render(<Page />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("alpha");
  fixture.name = "external-edit";
  await userEvent.click(screen.getByRole("button", { name: "Reload", exact: true }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("external-edit");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Profiles folder", exact: true }),
    "second",
  );
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: "beta", exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByRole("status")).toHaveTextContent("beta");
});
