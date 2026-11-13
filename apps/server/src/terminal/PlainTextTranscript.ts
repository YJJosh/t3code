const DEFAULT_MAX_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 4_096;
const MAX_ESCAPE_CHARS = 4_096;

const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
const CSI_UNFINISHED = /\x1b\[[0-?]*[ -/]*$/y;
const STRING_SEQUENCE = /\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/y;

export interface TranscriptRead {
  readonly text: string;
  /** Committed output ends here; the unfinished line in `text` is read again once it ends. */
  readonly cursor: number;
  readonly truncated: boolean;
}

function tailBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, cut: false };
  // Drop a code point split by the byte cut.
  const tail = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  return { text: tail.replace(/^�+/, ""), cut: true };
}

/**
 * Terminal output as plain text for an agent: escape sequences dropped, carriage returns and
 * erase-line applied per line, so progress bars and prompts read like the screen did. Cursors
 * are absolute character offsets into committed lines, stable while older text is dropped.
 */
export class PlainTextTranscript {
  private committed = "";
  private start = 0;
  private line: string[] = [];
  private column = 0;
  private escape = "";

  private readonly maxChars: number;

  constructor(maxChars = DEFAULT_MAX_CHARS) {
    this.maxChars = maxChars;
  }

  get end(): number {
    return this.start + this.committed.length;
  }

  get pendingLine(): string {
    return this.line.join("").trimEnd();
  }

  append(raw: string): void {
    const input = this.escape + raw;
    this.escape = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === "\x1b") {
        const consumed = this.applyEscape(input, index);
        if (consumed === null) {
          const rest = input.slice(index);
          this.escape = rest.length > MAX_ESCAPE_CHARS ? "" : rest;
          return;
        }
        index += consumed;
        continue;
      }
      index += 1;
      if (char === "\n") this.commitLine();
      else if (char === "\r") this.column = 0;
      else if (char === "\b") this.column = Math.max(0, this.column - 1);
      else if ((char === "\t" || char >= " ") && char !== "\x7f") this.put(char);
    }
  }

  /** Commits the unfinished line, as when the shell starts over. */
  break(): void {
    if (this.line.length > 0) this.commitLine();
    this.escape = "";
  }

  read(cursor: number | undefined, maxBytes: number): TranscriptRead {
    const from =
      cursor === undefined ? this.start : Math.min(Math.max(cursor, this.start), this.end);
    const lost = cursor !== undefined && cursor < this.start;
    const pending = this.pendingLine;
    const text = this.committed.slice(from - this.start) + pending;
    const capped = tailBytes(text, maxBytes);
    return { text: capped.text, cursor: this.end, truncated: lost || capped.cut };
  }

  /** Text after `cursor`, including the unfinished line, for matching. */
  textSince(cursor: number): string {
    const from = Math.min(Math.max(cursor, this.start), this.end);
    return this.committed.slice(from - this.start) + this.pendingLine;
  }

  private put(char: string): void {
    while (this.line.length < this.column) this.line.push(" ");
    this.line[this.column] = char;
    this.column += 1;
    if (this.line.length >= MAX_LINE_CHARS) this.commitLine();
  }

  private commitLine(): void {
    this.committed += `${this.line.join("").trimEnd()}\n`;
    this.line = [];
    this.column = 0;
    const excess = this.committed.length - this.maxChars;
    if (excess > 0) {
      this.committed = this.committed.slice(excess);
      this.start += excess;
    }
  }

  /** Characters consumed, or null when the sequence continues in later output. */
  private applyEscape(text: string, at: number): number | null {
    const second = text[at + 1];
    if (second === undefined) return null;
    if (second === "[") {
      CSI.lastIndex = at;
      const csi = CSI.exec(text);
      if (csi) {
        this.applyCsi(csi[1] ?? "", csi[2]!);
        return csi[0].length;
      }
      CSI_UNFINISHED.lastIndex = at;
      return CSI_UNFINISHED.test(text) ? null : 2;
    }
    if ("]P_^X".includes(second)) {
      STRING_SEQUENCE.lastIndex = at;
      const sequence = STRING_SEQUENCE.exec(text);
      return sequence ? sequence[0].length : null;
    }
    if ("()#%*+".includes(second)) return at + 2 < text.length ? 3 : null;
    return 2;
  }

  private applyCsi(params: string, final: string): void {
    if (params.startsWith("?") || params.startsWith(">") || params.startsWith("<")) return;
    const count = Math.max(1, Number.parseInt(params || "1", 10) || 1);
    switch (final) {
      case "K": {
        const mode = params === "" ? 0 : Number.parseInt(params, 10);
        if (mode === 0) this.line = this.line.slice(0, this.column);
        else if (mode === 1)
          this.line = this.line.map((cell, at) => (at < this.column ? " " : cell));
        else this.line = [];
        return;
      }
      case "G":
        this.column = Math.min(MAX_LINE_CHARS - 1, count - 1);
        return;
      case "C":
        this.column = Math.min(MAX_LINE_CHARS - 1, this.column + count);
        return;
      case "D":
        this.column = Math.max(0, this.column - count);
        return;
      case "E":
        this.commitLine();
        return;
    }
  }
}
