// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

let root = "";

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
});

afterAll(async () => {
  if (root.length > 0) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("listTranscriptFiles", () => {
  it("returns an empty listing for a missing root", async () => {
    const listing = await listTranscriptFiles(NodePath.join(root, "does-not-exist"), 0);

    expect(listing).toEqual({ files: [], unreadableDirectories: 1 });
  });

  it("limits Pi subagent discovery to run session transcripts", async () => {
    const runs = NodePath.join(root, "subagent-runs");
    const session = NodePath.join(runs, "run-1", "session", "child.jsonl");
    const eventJournal = NodePath.join(runs, "run-1", "events.v1.jsonl");
    const nestedLog = NodePath.join(runs, "run-1", "workflow", "trace.jsonl");
    await NodeFSP.mkdir(NodePath.dirname(session), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(nestedLog), { recursive: true });
    await Promise.all([
      NodeFSP.writeFile(session, "{}\n", "utf8"),
      NodeFSP.writeFile(eventJournal, "{}\n", "utf8"),
      NodeFSP.writeFile(nestedLog, "{}\n", "utf8"),
    ]);

    const listing = await listTranscriptFiles(runs, 0, {
      maxDepth: 2,
      piSubagentSessionsOnly: true,
    });

    expect(listing.files.map((file) => file.path)).toEqual([session]);
    expect(listing.unreadableDirectories).toBe(0);
  });

  it("can inspect only direct Pi v0.30 legacy session files", async () => {
    const agent = NodePath.join(root, "legacy-agent");
    const directSession = NodePath.join(agent, "legacy.jsonl");
    const nestedSession = NodePath.join(agent, "sessions", "project", "new.jsonl");
    await NodeFSP.mkdir(NodePath.dirname(nestedSession), { recursive: true });
    await Promise.all([
      NodeFSP.writeFile(directSession, "{}\n", "utf8"),
      NodeFSP.writeFile(nestedSession, "{}\n", "utf8"),
    ]);

    const listing = await listTranscriptFiles(agent, 0, { maxDepth: 0 });

    expect(listing.files.map((file) => file.path)).toEqual([directSession]);
    expect(listing.unreadableDirectories).toBe(0);
  });
});

describe("readTranscriptRecords for Pi", () => {
  it("captures the project path and parses usage", async () => {
    const filePath = NodePath.join(root, "pi-session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s1", cwd: "/home/theo/proj" }),
      JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-fable-5" }),
      '{"usage": this is broken json',
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-14T10:00:05.000Z",
        message: { role: "assistant", usage: { input: 30, output: 12 } },
      }),
    ];
    await NodeFSP.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const result = await readTranscriptRecords(filePath, "pi");

    expect(result).not.toBeNull();
    expect(result?.projectPaths).toEqual(["/home/theo/proj"]);
    expect(result?.records).toHaveLength(1);
    expect(result?.records[0]?.model).toBe("anthropic/claude-fable-5");
    expect(result?.records[0]?.sessionId).toBe("s1");
  });

  it("returns null when the file cannot be read", async () => {
    expect(await readTranscriptRecords(NodePath.join(root, "gone.jsonl"), "pi")).toBeNull();
  });
});
