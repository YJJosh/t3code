// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native adapter owns process-group cancellation and streaming secret masking.
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";

const OUTPUT_LIMIT = 30_000;

// Keep undecided text until even a secret split across UTF-8 chunks can be masked.
export class MaskedOutput {
  private readonly decoder = new NodeStringDecoder.StringDecoder("utf8");
  private pending = "";
  private output = "";
  private readonly values: string[];
  private readonly width: number;
  constructor(values: ReadonlyArray<string>) {
    this.values = values.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
    this.width = Math.max(1, ...this.values.map((value) => value.length));
  }
  write(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    this.flush(false);
  }
  private flush(final: boolean) {
    const boundary = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.width + 1);
    let offset = 0;
    while (offset < boundary) {
      let start = -1;
      let found: string | undefined;
      for (const value of this.values) {
        const at = this.pending.indexOf(value, offset);
        if (at >= 0 && (start < 0 || at < start)) {
          start = at;
          found = value;
        }
      }
      if (found === undefined || start >= boundary) {
        this.output += this.pending.slice(offset, boundary);
        offset = boundary;
        break;
      }
      this.output += this.pending.slice(offset, start) + "<concealed>";
      offset = start + found.length;
    }
    this.pending = this.pending.slice(offset);
    this.output = this.output.slice(-OUTPUT_LIMIT);
  }
  finish() {
    this.pending += this.decoder.end();
    this.flush(true);
    return this.output;
  }
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function runSecretProcess(input: {
  readonly platform: NodeJS.Platform;
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly shell?: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly mask?: ReadonlyArray<string>;
  readonly stdin?: string;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.file, [...input.args], {
      env: input.env,
      cwd: input.cwd,
      shell: input.shell,
      detached: input.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const masked =
      input.mask === undefined
        ? undefined
        : {
            stdout: new MaskedOutput(input.mask),
            stderr: new MaskedOutput(input.mask),
          };
    const stdoutDecoder = new NodeStringDecoder.StringDecoder("utf8");
    const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let size = 0;
    let exceeded = false;
    let timedOut = false;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (input.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* The owned process group already exited. */
      }
    };
    // @effect-diagnostics-next-line globalTimers:off -- Callback adapter timer kills the owned process group, including descendants holding pipes.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    input.signal.addEventListener("abort", kill, { once: true });
    if (input.signal.aborted) kill();
    child.stdout.on("data", (chunk: Buffer) => {
      if (masked) masked.stdout.write(chunk);
      else {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          exceeded = true;
          kill();
        } else stdout += stdoutDecoder.write(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (masked) masked.stderr.write(chunk);
      else stderr = (stderr + stderrDecoder.write(chunk)).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin);
    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", kill);
      kill();
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(new Error(error.code === "ENOENT" ? "missing_binary" : "process_failed"));
    });
    child.once("close", (code) => {
      cleanup();
      if (exceeded) {
        reject(new Error("output_limit"));
        return;
      }
      resolve({
        code,
        timedOut,
        stdout: masked?.stdout.finish() ?? stdout + stdoutDecoder.end(),
        stderr: masked?.stderr.finish() ?? stderr + stderrDecoder.end(),
      });
    });
  });
}
