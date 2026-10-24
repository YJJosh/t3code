import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { AgentSessionImportSource } from "./agentSessions.ts";

it("decodes Pi import identities without changing existing source formats", () => {
  const decode = Schema.decodeUnknownSync(AgentSessionImportSource);
  const source = {
    provider: "pi",
    providerInstanceId: "pi-work",
    providerSessionId: "session",
    filePath: "/pi/session.jsonl",
    size: 10,
    mtimeMs: 1,
    device: 1,
    inode: 2,
    birthtimeMs: 1,
  };
  expect(decode(source)).toEqual(source);
});
