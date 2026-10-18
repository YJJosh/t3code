import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
  cwd: Schema.String,
});
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
/** UUID-only fork cursors predate sessionFile. Search Pi's two-level session layout,
 * bounded by directories, names and header bytes; never infer identity from a filename alone. */
export const findDulliSessionFile = Effect.fn(function* (
  agentDirs: ReadonlyArray<string>,
  sessionId: string,
  cwd: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(cwd)) return null;
  // Historical Workler checkouts may already be gone. Exact absolute header
  // identity is still valid; requiring a live directory would strand the cursor.
  const expectedCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  let budget = 10_000;
  let found: string | null = null;
  for (const agentDir of agentDirs.slice(0, 32)) {
    const root = path.join(agentDir, "sessions");
    const directories = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const directory of directories.slice(0, 512)) {
      const folder = path.join(root, directory);
      const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (--budget < 0) return null;
        if (!name.endsWith(`_${sessionId}.jsonl`) && name !== `${sessionId}.jsonl`) continue;
        const candidate = yield* Effect.gen(function* () {
          const filePath = yield* fs.realPath(path.join(folder, name));
          const file = yield* fs.open(filePath, { flag: "r" });
          const bytes = yield* file.readAlloc(16 * 1024);
          if (Option.isNone(bytes)) return null;
          const line = new TextDecoder().decode(bytes.value).split("\n")[0];
          const header = decodeHeader(line);
          if (
            Option.isNone(header) ||
            header.value.id !== sessionId ||
            !path.isAbsolute(header.value.cwd)
          )
            return null;
          const headerCwd = yield* fs
            .realPath(header.value.cwd)
            .pipe(Effect.orElseSucceed(() => path.resolve(header.value.cwd)));
          return headerCwd === expectedCwd ? filePath : null;
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => null),
        );
        if (candidate !== null) {
          if (found !== null && candidate !== found) return null;
          found = candidate;
        }
      }
    }
  }
  return found;
});
