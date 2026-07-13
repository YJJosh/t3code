import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildInitialPiProviderSnapshot } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("advertises the configured Pi profile as a model option", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(
        decodePiSettings({
          profile: "reviewer",
          customModels: ["anthropic/claude-sonnet-5"],
        }),
      );

      const profileDescriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "profile",
      );
      expect(profileDescriptor).toMatchObject({
        id: "profile",
        label: "Profile",
        type: "select",
        currentValue: "reviewer",
        options: [{ id: "reviewer", label: "reviewer", isDefault: true }],
      });
    }),
  );
});
