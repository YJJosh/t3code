import type { PiBackgroundTerminalScreen } from "@t3tools/contracts";

/** A full repaint, never replay raw PTY output (which may contain terminal queries). */
export function screenToVt(screen: PiBackgroundTerminalScreen): string {
  const mode = (id: number, enabled: boolean) => `\x1b[?${id}${enabled ? "h" : "l"}`;
  return (
    "\x1b[?7l\x1b[0m\x1b[2J" +
    screen.lines.map((line, y) => `\x1b[${y + 1};1H${line}`).join("") +
    `\x1b[0m\x1b[${screen.cursorY + 1};${screen.cursorX + 1}H` +
    mode(25, screen.cursorVisible) +
    mode(1, screen.applicationCursorKeysMode) +
    mode(2004, screen.bracketedPasteMode) +
    "\x1b[2 q"
  );
}

/** Serial bounded batches preserve paste/key order even over a slow remote connection. */
export function createTerminalInputBatcher(
  send: (data: string) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let disposed = false;
  const encoder = new TextEncoder();
  const schedule = () => {
    if (!disposed && pending && !timer && !sending) timer = setTimeout(() => void flush(), 20);
  };
  const flush = async () => {
    timer = undefined;
    if (disposed || sending || !pending) return;
    // Code points are never split, and 4096 UTF-16 units fit the 16 KiB wire limit.
    let end = Math.min(pending.length, 4096);
    if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1]!)) end--;
    const data = pending.slice(0, end);
    pending = pending.slice(end);
    sending = true;
    try {
      await send(data);
    } catch (error) {
      pending = "";
      onError(error);
    } finally {
      sending = false;
      schedule();
    }
  };
  return {
    push(data: string) {
      if (disposed) return;
      if (encoder.encode(pending + data).length > 64 * 1024) {
        onError(new Error("Input queue is full. Paste at most 64 KiB at a time."));
        return;
      }
      pending += data;
      schedule();
    },
    dispose() {
      disposed = true;
      pending = "";
      if (timer) clearTimeout(timer);
    },
  };
}
