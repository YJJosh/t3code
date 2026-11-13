import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Profiles from "./Profiles.ts";

const layer = Profiles.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "reads ordered prompts and skill metadata, refreshes files, and reports invalid files without throwing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Profiles.Profiles;
      const root = yield* fs.makeTempDirectoryScoped();
      assert.deepEqual((yield* service.load(root)).catalog.profiles, {});
      yield* fs.makeDirectory(`${root}/prompts`, { recursive: true });
      yield* fs.makeDirectory(`${root}/skills/review`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/profiles.json`,
        JSON.stringify({
          default: "coder",
          profiles: { coder: { prompts: ["first", "second"], skills: ["review"] } },
        }),
      );
      yield* fs.writeFileString(`${root}/prompts/first.md`, "First instruction");
      yield* fs.writeFileString(`${root}/prompts/second.md`, "Second instruction");
      yield* fs.writeFileString(
        `${root}/skills/review/SKILL.md`,
        "---\nname: review\ndescription: Review <code>\n---\nPrivate skill body",
      );
      const loaded = yield* service.load(root);
      assert.equal(loaded.catalog.default, "coder");
      assert.include(loaded.instructions.coder!, "First instruction\n\nSecond instruction");
      assert.include(loaded.instructions.coder!, "Review &lt;code&gt;");
      assert.include(loaded.instructions.coder!, `${root}/skills/review/SKILL.md`);
      assert.notInclude(loaded.instructions.coder!, "Private skill body");
      yield* fs.writeFileString(`${root}/prompts/first.md`, "Updated instruction");
      assert.include((yield* service.load(root)).instructions.coder!, "Updated instruction");
      yield* fs.makeDirectory(`${root}/skills/broken`, { recursive: true });
      for (const { broken, warning, skillContent } of [
        { broken: { prompts: ["missing"], skills: [] }, warning: "missing.md" },
        { broken: { prompts: [], skills: ["missing"] }, warning: "missing/SKILL.md" },
        {
          broken: { prompts: [], skills: ["broken"] },
          warning: "broken/SKILL.md",
          skillContent: "No frontmatter",
        },
        {
          broken: { prompts: [], skills: ["broken"] },
          warning: "broken/SKILL.md",
          skillContent: "---\nname: [\n---",
        },
        {
          broken: { prompts: [], skills: ["broken"] },
          warning: "description",
          skillContent: "---\nname: broken\ndescription: 42\n---",
        },
        { broken: { prompts: ["../escape"], skills: [] }, warning: "prompts" },
        { broken: { prompts: [], skills: [], effort: 42 }, warning: "effort" },
        { broken: null, warning: "profiles.json" },
      ]) {
        if (skillContent) yield* fs.writeFileString(`${root}/skills/broken/SKILL.md`, skillContent);
        yield* fs.writeFileString(
          `${root}/profiles.json`,
          JSON.stringify({
            profiles: { coder: { prompts: ["first"], skills: [] }, broken },
          }),
        );
        const mixed = yield* service.load(root);
        assert.isUndefined(mixed.catalog.error);
        assert.deepEqual(Object.keys(mixed.catalog.profiles), ["coder", "broken"]);
        assert.equal(mixed.instructions.coder, "Updated instruction");
        assert.isUndefined(mixed.instructions.broken);
        assert.include(mixed.catalog.profiles.broken!.warning!, warning);
      }
      yield* fs.writeFileString(
        `${root}/profiles.json`,
        '{"profiles":{"broken":{"prompts":["first"],"skills":[]}}}',
      );
      const repaired = yield* service.load(root);
      assert.isUndefined(repaired.catalog.profiles.broken!.warning);
      assert.equal(repaired.instructions.broken, "Updated instruction");
      yield* fs.writeFileString(`${root}/profiles.json`, '{"profiles":');
      assert.include((yield* service.load(root)).catalog.error!, "profiles.json");
      yield* fs.writeFileString(`${root}/profiles.json`, '{"default":"missing","profiles":{}}');
      assert.include((yield* service.load(root)).catalog.error!, "Default profile");
    }).pipe(Effect.provide(layer), Effect.scoped),
);
