import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProfilesSkillsInput } from "./profiles.ts";

const decode = Schema.decodeUnknownExit(ProfilesSkillsInput);

it("rejects option-like and whitespace-containing skill sources before RPC normalization", () => {
  for (const source of [
    "-bad",
    " owner/repo",
    "owner/repo ",
    "owner/repo --global",
    "owner\nrepo",
    "owner\0repo",
  ]) {
    assert.equal(decode({ _tag: "add", source })._tag, "Failure");
  }
  for (const source of ["owner/repo", "https://github.com/owner/repo", "/tmp/local-skills"]) {
    assert.equal(decode({ _tag: "add", source })._tag, "Success");
  }
});
