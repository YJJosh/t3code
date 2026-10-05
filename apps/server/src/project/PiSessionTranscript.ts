import type { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PiSessionInfo } from "../provider/PiSessionsClient.ts";
import type { AgentSessionRecentThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Literal(3)),
  id: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)),
  cwd: Schema.NonEmptyString,
  timestamp: Schema.String,
});
const Entry = Schema.Struct({
  type: Schema.Literals([
    "message",
    "model_change",
    "thinking_level_change",
    "compaction",
    "branch_summary",
    "custom",
    "label",
    "session_info",
    "custom_message",
  ]),
  id: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.NonEmptyString),
  timestamp: Schema.String,
  message: Schema.optional(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(Header));
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));
const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
);
const MAX_BYTES = 16 * 1024 * 1024;
const iso = (value: string) => DateTime.formatIso(DateTime.makeUnsafe(value));

export class PiSessionTranscript extends Context.Service<
  PiSessionTranscript,
  {
    readonly read: (
      record: PiSessionInfo,
      instanceId: ProviderInstanceId,
      workspaceRoot: string,
    ) => Effect.Effect<AgentSessionRecentThread | null>;
  }
>()("t3/project/PiSessionTranscript") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read: PiSessionTranscript["Service"]["read"] = (record, instanceId, workspaceRoot) =>
    Effect.gen(function* () {
      if (
        !record.sessionFile ||
        !path.isAbsolute(record.sessionFile) ||
        !path.isAbsolute(record.cwd)
      )
        return null;
      const filePath = yield* fs.realPath(record.sessionFile);
      const file = yield* fs.open(filePath, { flag: "r" });
      const before = yield* file.stat;
      const size = Number(before.size);
      if (before.type !== "File" || size === 0 || size > MAX_BYTES) return null;
      const chunks: Uint8Array[] = [];
      let remaining = size;
      while (remaining > 0) {
        const chunk = yield* file.readAlloc(Math.min(64 * 1024, remaining));
        if (Option.isNone(chunk)) return null;
        remaining -= chunk.value.length;
        chunks.push(chunk.value);
      }
      const after = yield* file.stat;
      const current = yield* fs.stat(filePath);
      const same = (stat: FileSystem.File.Info) =>
        stat.size === before.size &&
        Option.getOrNull(stat.ino) === Option.getOrNull(before.ino) &&
        stat.dev === before.dev &&
        Option.getOrNull(stat.mtime)?.getTime() === Option.getOrNull(before.mtime)?.getTime();
      if (!same(after) || !same(current)) return null;
      const contents = yield* Effect.try(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      const lines = contents.trimEnd().split("\n");
      if (lines.length > 100_000) return null;
      const header = yield* Effect.try(() => decodeHeader(lines[0]!));
      if (
        header.id !== record.sessionId ||
        !path.isAbsolute(header.cwd) ||
        (yield* fs.realPath(header.cwd)) !== workspaceRoot ||
        (yield* fs.realPath(record.cwd)) !== workspaceRoot
      )
        return null;
      return yield* Effect.try(() => {
        const entries = new Map<string, typeof Entry.Type>();
        let leaf: typeof Entry.Type | undefined;
        for (const line of lines.slice(1)) {
          const entry = decodeEntry(line);
          iso(entry.timestamp);
          if (entries.has(entry.id) || (entry.parentId !== null && !entries.has(entry.parentId)))
            throw new Error("Invalid Pi session tree");
          if (entry.type === "message" && !entry.message) throw new Error("Missing Pi message");
          if (entry.type === "model_change" && (!entry.provider || !entry.modelId))
            throw new Error("Missing Pi model");
          entries.set(entry.id, entry);
          leaf = entry;
        }
        const branch: (typeof Entry.Type)[] = [];
        while (leaf) {
          branch.push(leaf);
          leaf = leaf.parentId === null ? undefined : entries.get(leaf.parentId);
        }
        branch.reverse();
        const messages: AgentSessionThreadMessage[] = [];
        let model: string | null = null;
        let title: string | undefined;
        for (const entry of branch) {
          if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
          if (entry.type === "session_info" && entry.name?.trim()) title = entry.name.trim();
          const message = entry.type === "message" ? entry.message : undefined;
          if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
          const text =
            typeof message.content === "string"
              ? message.content
              : decodeBlocks(message.content)
                  .filter((block) => block.type === "text")
                  .map((block) => block.text ?? "")
                  .join("\n");
          if (text.trim())
            messages.push({ role: message.role, text, createdAt: iso(entry.timestamp) });
        }
        const firstUser = messages.find((message) => message.role === "user");
        if (!firstUser) return null;
        const retained = messages.length <= 200 ? messages : [firstUser, ...messages.slice(-199)];
        return {
          _tag: "Importable",
          thread: {
            source: "pi",
            providerInstanceId: instanceId,
            providerSessionId: record.sessionId,
            title: (record.title?.trim() || title || firstUser.text.trim().split("\n")[0]!).slice(
              0,
              100,
            ),
            model,
            createdAt: iso(header.timestamp),
            updatedAt: iso(branch.at(-1)?.timestamp ?? header.timestamp),
            messages: retained,
          },
          source: {
            provider: "pi",
            providerInstanceId: instanceId,
            providerSessionId: record.sessionId,
            filePath,
            size,
            mtimeMs: Option.getOrNull(before.mtime)?.getTime() ?? null,
            device: before.dev,
            inode: Option.getOrNull(before.ino),
            birthtimeMs: Option.getOrNull(before.birthtime)?.getTime() ?? null,
          },
        } satisfies AgentSessionRecentThread;
      });
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
  return PiSessionTranscript.of({ read });
});
export const layer = Layer.effect(PiSessionTranscript, make);
