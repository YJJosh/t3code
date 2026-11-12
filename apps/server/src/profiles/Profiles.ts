import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";
import { ProfilesFile, type ProfileCatalog } from "@t3tools/contracts";

class ProfileLoadError extends Schema.TaggedError<ProfileLoadError>()("ProfileLoadError", {
  path: Schema.String,
  operation: Schema.Literals(["read", "decode", "default"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.operation === "default"
      ? `Default profile does not exist in ${this.path}.`
      : `Could not ${this.operation} ${this.path}. Check the profiles format and file permissions.`;
  }
}

const SkillMetadata = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});
const decodeProfiles = Schema.decodeEffect(Schema.fromJsonString(ProfilesFile));
const decodeSkillMetadata = Schema.decodeUnknownEffect(SkillMetadata);
const isProfileLoadError = Schema.is(ProfileLoadError);
const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export class Profiles extends Context.Service<
  Profiles,
  {
    readonly load: (folder: string) => Effect.Effect<{
      readonly catalog: ProfileCatalog;
      readonly instructions: Readonly<Record<string, string>>;
    }>;
  }
>()("t3/profiles/Profiles") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = Effect.fn("Profiles.read")(function* (file: string) {
    return yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((cause) => new ProfileLoadError({ path: file, operation: "read", cause })),
      );
  });
  const load = Effect.fn("Profiles.load")(function* (folder: string) {
    const root = path.resolve(folder);
    const file = path.join(root, "profiles.json");
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file)))
        return { catalog: { folder: root, profiles: {} }, instructions: {} };
      const config = yield* decodeProfiles(yield* read(file)).pipe(
        Effect.mapError(
          (cause) => new ProfileLoadError({ path: file, operation: "decode", cause }),
        ),
      );
      if (config.default !== undefined && !Object.hasOwn(config.profiles, config.default)) {
        return yield* new ProfileLoadError({ path: file, operation: "default", cause: undefined });
      }
      const instructions: Record<string, string> = {};
      for (const [id, profile] of Object.entries(config.profiles)) {
        const parts: string[] = [];
        for (const prompt of profile.prompts)
          parts.push(yield* read(path.join(root, "prompts", `${prompt}.md`)));
        const skills: string[] = [];
        for (const skill of profile.skills) {
          const skillPath = path.join(root, "skills", skill, "SKILL.md");
          const content = yield* read(skillPath);
          const rawMetadata = yield* Effect.try({
            try: () => {
              const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
              return parseYaml(match?.[1] ?? "");
            },
            catch: (cause) => new ProfileLoadError({ path: skillPath, operation: "decode", cause }),
          });
          const metadata = yield* decodeSkillMetadata(rawMetadata).pipe(
            Effect.mapError(
              (cause) => new ProfileLoadError({ path: skillPath, operation: "decode", cause }),
            ),
          );
          skills.push(
            `<skill><name>${escapeXml(metadata.name)}</name><description>${escapeXml(metadata.description)}</description><location>${escapeXml(skillPath)}</location></skill>`,
          );
        }
        if (skills.length > 0)
          parts.push(
            `Read a skill's SKILL.md before using it. Resolve relative paths against its directory.\n<available_skills>\n${skills.join("\n")}\n</available_skills>`,
          );
        instructions[id] = parts.join("\n\n");
      }
      return { catalog: { folder: root, ...config }, instructions };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          catalog: {
            folder: root,
            profiles: {},
            error: isProfileLoadError(cause)
              ? cause.message
              : `Could not read ${file}. Check file permissions.`,
          },
          instructions: {},
        }),
      ),
    );
  });
  return Profiles.of({ load });
});

export const layer = Layer.effect(Profiles, make);
