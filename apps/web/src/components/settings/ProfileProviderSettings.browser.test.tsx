import { useState } from "react";
import type { ProviderSettingsFile } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ProviderSettingsEditor } from "./ProfileProviderSettings";

function Editor() {
  const [value, setValue] = useState<ProviderSettingsFile>({
    claudeAgent: { full: {} },
    codex: { full: {} },
  });
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <ProviderSettingsEditor
        value={value}
        options={null}
        optionsError={null}
        optionsPending={false}
        onRefreshOptions={() => undefined}
        disabled={false}
        dirty={false}
        onChange={setValue}
        onRename={() => undefined}
        usedBy={() => []}
        resetKey={0}
        onJsonValidity={(key, valid) =>
          setInvalid((current) => {
            const next = new Set(current);
            if (valid) next.delete(key);
            else next.add(key);
            return next;
          })
        }
      />
      <button disabled={invalid.size > 0}>Save settings</button>
    </>
  );
}

it("does not leave saving blocked after switching away from discarded invalid JSON", async () => {
  await using screen = await render(<Editor />);
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Advanced settings", exact: true }),
    "{",
  );
  await expect
    .element(screen.getByRole("button", { name: "Save settings", exact: true }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Codex", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Claude", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Advanced settings", exact: true }))
    .toHaveValue("");
  await expect
    .element(screen.getByRole("button", { name: "Save settings", exact: true }))
    .toBeEnabled();
});
