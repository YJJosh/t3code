import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

export const Profile = Schema.Struct({
  description: Schema.optionalKey(TrimmedNonEmptyString),
  prompts: Schema.Array(ProfileId),
  skills: Schema.Array(ProfileId),
  provider: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  effort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type Profile = typeof Profile.Type;

export const ProfilesFile = Schema.Struct({
  default: Schema.optionalKey(ProfileId),
  profiles: Schema.Record(ProfileId, Profile),
});
export type ProfilesFile = typeof ProfilesFile.Type;

export const ProfileCatalog = Schema.Struct({
  folder: Schema.String,
  default: Schema.optionalKey(ProfileId),
  profiles: Schema.Record(ProfileId, Profile),
  error: Schema.optionalKey(Schema.String),
});
export type ProfileCatalog = typeof ProfileCatalog.Type;
