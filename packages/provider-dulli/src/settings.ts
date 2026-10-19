/** Browser-safe Dulli settings; native Pi paths and extension names are unchanged. */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DulliSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary used by Dulli.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    profile: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("coder")),
      Schema.annotateKey({
        title: "Profile",
        description: "Default Pi profile for new conversations.",
        providerSettingsForm: { placeholder: "coder", clearWhenEmpty: "omit" },
      }),
    ),
    agentDir: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Agent directory",
        description:
          "Pi configuration home. Empty uses PI_CODING_AGENT_DIR, TAU_CODING_AGENT_DIR, or ~/.pi/agent.",
        providerSettingsForm: { placeholder: "~/.pi/agent", clearWhenEmpty: "omit" },
      }),
    ),
    piSessions: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "pi-sessions",
        description: "Allow the native pi-sessions extension. Disable to set PI_SESSIONS=off.",
      }),
    ),
    shareWithTerminal: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Share with terminal",
        description: "Allow sharing through the optional pi-sessions integration.",
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath", "profile", "agentDir", "piSessions", "shareWithTerminal"] },
);
export type DulliSettings = typeof DulliSettings.Type;
