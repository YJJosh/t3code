import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-08-24T10:00:00.000Z";
const entry = (id: string, parentId: string | null, data: object) => ({
  id,
  parentId,
  timestamp,
  ...data,
});
const message = (id: string, parentId: string | null, role: string, content: unknown) =>
  entry(id, parentId, { type: "message", message: { role, content } });
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const cwd = yield* fs.realPath(root);
  const sessionFile = `${root}/session.jsonl`;
  const record = {
    sessionId: "session",
    sessionFile,
    cwd,
    owner: "foreground" as const,
    status: "done" as const,
    live: false,
    attached: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  const reader = yield* PiSessionTranscript.PiSessionTranscript;
  const header = { type: "session", version: 3, id: "session", timestamp, cwd };
  return {
    fs,
    root,
    record,
    header,
    read: (override = {}) =>
      reader.read({ ...record, ...override }, ProviderInstanceId.make("pi-work"), cwd),
    write: (entries: readonly unknown[]) =>
      fs.writeFileString(sessionFile, entries.map((value) => encode(value)).join("\n") + "\n"),
  };
});

it.layer(NodeServices.layer)("PiSessionTranscript", (it) => {
  it.effect("rejects a transcript that changes while it is being read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([f.header, message("u", null, "user", "hello")]);
      const reader = yield* PiSessionTranscript.PiSessionTranscript.pipe(
        Effect.provide(Layer.fresh(PiSessionTranscript.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          open: (...args) =>
            f.fs.open(...args).pipe(
              Effect.map((file) => ({
                ...file,
                stat: file.stat,
                readAlloc: (size) =>
                  file
                    .readAlloc(size)
                    .pipe(
                      Effect.tap(() =>
                        f.fs.writeFileString(f.record.sessionFile, "\n", { flag: "a" }),
                      ),
                    ),
              })),
            ),
        }),
      );
      expect(yield* reader.read(f.record, ProviderInstanceId.make("pi"), f.record.cwd)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );

  it.effect("imports only active-branch user/assistant text, model, and title", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([
        f.header,
        entry("m1", null, { type: "model_change", provider: "anthropic", modelId: "old" }),
        message("u", "m1", "user", "first prompt"),
        message("abandoned", "u", "assistant", "wrong branch"),
        entry("m2", "u", { type: "model_change", provider: "openai", modelId: "model" }),
        message("tool", "m2", "toolResult", "tool output"),
        message("a", "tool", "assistant", [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "answer" },
          { type: "image", data: "hidden" },
        ]),
        entry("name", "a", { type: "session_info", name: "Session title" }),
      ]);
      const outcome = yield* f.read();
      expect(outcome).toMatchObject({
        _tag: "Importable",
        thread: {
          title: "Session title",
          model: "openai/model",
          providerInstanceId: "pi-work",
          messages: [
            { role: "user", text: "first prompt" },
            { role: "assistant", text: "answer" },
          ],
        },
        source: { provider: "pi", providerSessionId: "session" },
      });
      expect(yield* f.read({ title: "Daemon title" })).toMatchObject({
        thread: { title: "Daemon title" },
      });
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );

  it.effect("keeps each text block of an assistant message as its own paragraph", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([
        f.header,
        message("u", null, "user", "deploy it"),
        message("a", "u", "assistant", [
          { type: "text", text: "Checking the build." },
          { type: "thinking", thinking: "✓ Bash npm run build", claudeCodeSyntheticTool: true },
          { type: "text", text: "The build passed." },
        ]),
      ]);
      expect(yield* f.read()).toMatchObject({
        thread: {
          messages: [
            { role: "user", text: "deploy it" },
            { role: "assistant", text: "Checking the build.\n\nThe build passed." },
          ],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );

  it.effect("keeps reading through entry types it does not interpret", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([
        f.header,
        message("u", null, "user", "first prompt"),
        entry("usage", "u", { type: "usage", usage: { input: 1, output: 2 } }),
        entry("edit", "usage", { type: "context_edit", targetId: "u", replacement: null }),
        entry("future", "edit", { type: "added_in_a_later_pi" }),
        message("a", "future", "assistant", "answer"),
      ]);
      expect(yield* f.read()).toMatchObject({
        _tag: "Importable",
        thread: {
          messages: [
            { role: "user", text: "first prompt" },
            { role: "assistant", text: "answer" },
          ],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );

  it.effect("treats an entry with a missing parent as the start of the branch, like Pi", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([
        f.header,
        message("u", null, "user", "before the gap"),
        message("orphan", "missing", "user", "after the gap"),
        message("a", "orphan", "assistant", "answer"),
      ]);
      expect(yield* f.read()).toMatchObject({
        thread: {
          messages: [
            { role: "user", text: "after the gap" },
            { role: "assistant", text: "answer" },
          ],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );

  for (const mode of ["id", "cwd", "duplicate", "timestamp", "version", "partial"] as const) {
    it.effect(`rejects corrupt ${mode}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write([
          {
            ...f.header,
            ...(mode === "id"
              ? { id: "other" }
              : mode === "cwd"
                ? { cwd: "/not-the-project" }
                : mode === "version"
                  ? { version: 99 }
                  : mode === "timestamp"
                    ? { timestamp: "not a date" }
                    : {}),
          },
          message("u", null, "user", "hello"),
          ...(mode === "duplicate" ? [message("u", null, "user", "duplicate")] : []),
        ]);
        if (mode === "partial")
          yield* f.fs.writeFileString(f.record.sessionFile, "{", { flag: "a" });
        expect(yield* f.read()).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
    );
  }

  it.effect("retains first user plus recent history, and bounds file reads", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([
        f.header,
        ...Array.from({ length: 220 }, (_, i) =>
          message(
            String(i),
            i === 0 ? null : String(i - 1),
            i % 2 === 0 ? "user" : "assistant",
            `text ${i}`,
          ),
        ),
      ]);
      const outcome = yield* f.read();
      expect(outcome?._tag).toBe("Importable");
      if (outcome?._tag === "Importable") {
        expect(outcome.thread.messages).toHaveLength(200);
        expect(outcome.thread.messages[0]?.text).toBe("text 0");
        expect(outcome.thread.messages.at(-1)?.text).toBe("text 219");
      }
      yield* f.fs.truncate(f.record.sessionFile, 64 * 1024 * 1024 + 1);
      expect(yield* f.read()).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(PiSessionTranscript.layer)),
  );
});
