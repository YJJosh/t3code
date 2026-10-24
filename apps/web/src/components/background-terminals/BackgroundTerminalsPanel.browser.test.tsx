import {
  EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
  type BackgroundTerminalEntry,
  type BackgroundTerminalRuntimeState,
} from "@t3tools/client-runtime/state/background-terminals";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  runtime: null as BackgroundTerminalRuntimeState | null,
  start: vi.fn(),
}));

vi.mock("../../state/useBackgroundTerminalRuntime", () => ({
  useBackgroundTerminalRuntime: () => ({ state: state.runtime }),
}));
vi.mock(import("./useStartBackgroundTerminal"), async (original) => ({
  ...(await original()),
  useStartBackgroundTerminal: () => ({ available: true, start: state.start }),
}));
vi.mock(import("./BackgroundTerminalRuns"), async (original) => ({
  ...(await original()),
  // Selection is owned by the panel; terminal transport/rendering is independent.
  BackgroundTerminalDetail: ({ terminal }: { terminal: BackgroundTerminalEntry }) => (
    <div role="group" aria-label={`Selected ${terminal.view.id}`}>
      Terminal detail
    </div>
  ),
}));

import { BackgroundTerminalsPanel } from "./BackgroundTerminalsPanel";

function terminal(id: string): BackgroundTerminalEntry {
  const output = { text: "", totalBytes: 0, truncatedBytes: 0, clientTruncatedBytes: 0 };
  return {
    view: {
      id,
      command: `echo ${id}`,
      title: id,
      cwd: "/workspace",
      status: "running",
      createdAt: 0,
      stdout: output,
      stderr: output,
    },
    stdout: output,
    stderr: output,
    lastSequence: 1,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  state.runtime = {
    ...EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
    managerId: "manager",
    terminals: new Map(["first", "second"].map((id) => [id, terminal(id)])),
  };
  state.start.mockReset().mockResolvedValue({ requestId: "start-1" });
}

function panel(selectedTerminalId: string | null = null) {
  return (
    <BackgroundTerminalsPanel
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      enabled
      selectedTerminalId={selectedTerminalId}
    />
  );
}

it("follows a changed external selection without overriding a later roster choice", async () => {
  setup();
  await using screen = await render(panel("first"));
  await expect.element(screen.getByRole("group", { name: "Selected first" })).toBeVisible();
  await screen.rerender(panel("second"));
  await expect.element(screen.getByRole("group", { name: "Selected second" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "All terminals" }));
  await userEvent.click(screen.getByRole("button", { name: /Background terminal: first\./u }));
  await screen.rerender(panel("second"));
  await expect.element(screen.getByRole("group", { name: "Selected first" })).toBeVisible();
  await screen.rerender(panel());
  await expect.element(screen.getByRole("group", { name: "Selected first" })).toBeVisible();
});

it.each([true, false])(
  "handles the asynchronous start acknowledgement (success=%s)",
  async (success) => {
    setup();
    await using screen = await render(panel());
    await userEvent.click(screen.getByRole("button", { name: "Start terminal" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Command" }), "bash -i");
    await userEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
    await expect.element(screen.getByRole("button", { name: /Start$/u })).toBeDisabled();

    state.runtime = {
      ...state.runtime!,
      controlResults: [
        {
          requestId: "start-1",
          action: "start",
          success,
          ...(success ? { terminalId: "second" } : { error: "Shell unavailable" }),
          sequence: 2,
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    };
    await screen.rerender(panel());
    if (success) {
      await expect.element(screen.getByRole("group", { name: "Selected second" })).toBeVisible();
      await expect
        .element(screen.getByRole("form", { name: "Start a shared terminal" }))
        .not.toBeInTheDocument();
      // A later roster choice must not be replaced by the already-consumed result.
      await userEvent.click(screen.getByRole("button", { name: "All terminals" }));
      await userEvent.click(screen.getByRole("button", { name: /Background terminal: first\./u }));
      await screen.rerender(panel());
      await expect.element(screen.getByRole("group", { name: "Selected first" })).toBeVisible();
    } else {
      await expect.element(screen.getByRole("alert")).toHaveTextContent("Shell unavailable");
      await expect
        .element(screen.getByRole("button", { name: "Start", exact: true }))
        .toBeEnabled();
      await expect.element(screen.getByRole("textbox", { name: "Command" })).toHaveValue("bash -i");
    }
  },
);
