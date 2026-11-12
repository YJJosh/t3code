import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "./profiles.ts";

it("applies portable provider instances, warns on fallback, and keeps explicit opt-outs", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [{ slug: "haiku" }],
    },
  ] as ReadonlyArray<ServerProvider>;
  const current = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
  const profile = {
    prompts: [],
    skills: [],
    provider: ProviderInstanceId.make("claudeAgent-lean"),
    model: "haiku",
    effort: "low",
  };
  const fallback = selectProfile(current, "lean", profile, providers);
  assert.equal(fallback.selection.instanceId, "claudeAgent");
  assert.equal(fallback.selection.profileId, "lean");
  assert.equal(fallback.selection.model, "haiku");
  assert.deepEqual(fallback.selection.options, [{ id: "effort", value: "low" }]);
  assert.include(fallback.notice!, "claudeAgent-lean");
  const exact = selectProfile(current, "lean", profile, [
    ...providers,
    { ...providers[0]!, instanceId: profile.provider },
  ]);
  assert.equal(exact.selection.instanceId, profile.provider);
  assert.isUndefined(exact.notice);
  const unknown = selectProfile(
    current,
    "lean",
    { ...profile, provider: ProviderInstanceId.make("opaque-name") },
    providers,
  );
  assert.equal(unknown.selection.instanceId, current.instanceId);
  assert.isDefined(unknown.notice);
  assert.isNull(selectProfile(fallback.selection, null, undefined, providers).selection.profileId);
  assert.isTrue(supportsProfiles("acpRegistry"));
  assert.isFalse(supportsProfiles("cursor"));
});
