import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { findDulliSessionFile } from "./DulliSessionFile.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const id = "a2234567-1234-4234-8234-123456789012";
it.layer(NodeServices.layer)("Dulli UUID continuity", (it) => {
  it.effect(
    "finds and validates a session header, rejecting ambiguous files and other working directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temp = yield* fs.makeTempDirectoryScoped();
        const root = yield* fs.realPath(temp);
        const folder = `${root}/agent/sessions/--project--`;
        yield* fs.makeDirectory(folder, { recursive: true });
        const file = `${folder}/2026-01-01_${id}.jsonl`;
        yield* fs.writeFileString(file, encode({ type: "session", id, cwd: root }) + "\n");
        expect(yield* findDulliSessionFile([`${root}/agent`], id, root)).toBe(file);
        expect(yield* findDulliSessionFile([`${root}/agent`], id, folder)).toBeNull();
        yield* fs.copyFile(file, `${folder}/2026-01-02_${id}.jsonl`);
        expect(yield* findDulliSessionFile([`${root}/agent`], id, root)).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect("does not trust a matching filename with another session ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const folder = `${root}/sessions/--project--`;
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(
        `${folder}/time_${id}.jsonl`,
        encode({ type: "session", id: "wrong", cwd: root }),
      );
      expect(yield* findDulliSessionFile([root], id, root)).toBeNull();
    }).pipe(Effect.scoped),
  );
});
