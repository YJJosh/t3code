import { assert, describe, it } from "@effect/vitest";

import { PlainTextTranscript } from "./PlainTextTranscript.ts";
import { isTerminalReplyOnly } from "./terminalInput.ts";

describe("PlainTextTranscript", () => {
  it.each([
    ["colors and titles", "\x1b[1;32mok\x1b[0m \x1b]0;title\x07done\r\n", "ok done\n"],
    ["a progress bar redrawn with carriage returns", "10%\r50%\r100%\r\n", "100%\n"],
    ["erase to end of line", "downloading...\r\x1b[Kdone\r\n", "done\n"],
    ["backspace", "lss\b \b\r\n", "ls\n"],
    ["column moves", "abc\x1b[1Gx\x1b[2CZ\n", "xbcZ\n"],
    ["private modes and charset switches", "\x1b[?2004h\x1b(Bprompt$ \x1b[?25l\n", "prompt$\n"],
    ["DCS and APC strings", "a\x1bPq#0;1\x1b\\b\x1b_Gi=1\x1b\\c\n", "abc\n"],
  ])("strips %s", (_name, raw, expected) => {
    const transcript = new PlainTextTranscript();
    transcript.append(raw);
    assert.strictEqual(transcript.read(0, 1_000).text, expected);
  });

  it("keeps escape sequences split across chunks out of the text", () => {
    const transcript = new PlainTextTranscript();
    transcript.append("one\x1b[3");
    transcript.append("1mtwo\x1b]0;ti");
    transcript.append("tle\x07\n");
    assert.strictEqual(transcript.read(0, 1_000).text, "onetwo\n");
  });

  it("reads after a cursor and shows the unfinished line without committing it", () => {
    const transcript = new PlainTextTranscript();
    transcript.append("first\n$ ");
    const first = transcript.read(undefined, 1_000);
    assert.deepStrictEqual(first, { text: "first\n$", cursor: 6, truncated: false });

    transcript.append("echo hi\r\nhi\r\n$ ");
    assert.deepStrictEqual(transcript.read(first.cursor, 1_000), {
      text: "$ echo hi\nhi\n$",
      cursor: 19,
      truncated: false,
    });
  });

  it("caps reads in bytes and keeps the end", () => {
    const transcript = new PlainTextTranscript();
    transcript.append(`${"a".repeat(300)}\n${"é".repeat(10)}\n`);
    const read = transcript.read(0, 21);
    assert.strictEqual(read.text, `${"é".repeat(10)}\n`);
    assert.strictEqual(read.truncated, true);
    assert.strictEqual(read.cursor, 312);
  });

  it("flags a cursor whose output was already dropped and keeps cursors absolute", () => {
    const transcript = new PlainTextTranscript(10);
    transcript.append("0123456789\nabc\n");
    assert.strictEqual(transcript.end, 15);
    assert.deepStrictEqual(transcript.read(2, 1_000), {
      text: "56789\nabc\n",
      cursor: 15,
      truncated: true,
    });
    assert.deepStrictEqual(transcript.read(11, 1_000), {
      text: "abc\n",
      cursor: 15,
      truncated: false,
    });
    assert.strictEqual(transcript.textSince(11), "abc\n");
  });
});

describe("isTerminalReplyOnly", () => {
  it.each([
    ["cursor position report", "\x1b[12;40R", true],
    ["device attributes", "\x1b[?62;22c\x1b[>1;10;0c", true],
    ["focus in and out", "\x1b[I\x1b[O", true],
    ["SGR mouse", "\x1b[<0;10;5M\x1b[<0;10;5m", true],
    ["X10 mouse", "\x1b[M #!", true],
    ["OSC color reply", "\x1b]11;rgb:0000/0000/0000\x1b\\", true],
    ["DECRQM reply", "\x1b[?2004;1$y", true],
    ["typed text", "ls\r", false],
    ["Ctrl+C", "\x03", false],
    ["arrow key", "\x1b[A", false],
    ["a reply with typing after it", "\x1b[12;40Rq", false],
    ["bracketed paste", "\x1b[200~text\x1b[201~", false],
  ])("%s", (_name, data, expected) => {
    assert.strictEqual(isTerminalReplyOnly(data), expected);
  });
});
