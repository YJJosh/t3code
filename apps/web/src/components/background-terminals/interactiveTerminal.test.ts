import { afterEach, expect, it, vi } from "vite-plus/test";
import { createTerminalInputBatcher, screenToVt } from "./interactiveTerminal";

afterEach(() => vi.useRealTimers());

it("repaints cells without wrapping/scrolling, restores cursor and mirrors input modes", () => {
  const screen = {
    cols: 3,
    rows: 2,
    lines: ["\x1b[31mred\x1b[0m", "hi "],
    cursorX: 2,
    cursorY: 1,
    cursorVisible: false,
    applicationCursorKeysMode: true,
    bracketedPasteMode: true,
  };
  expect(screenToVt(screen)).toBe(
    "\x1b[?7l\x1b[0m\x1b[2J\x1b[1;1H\x1b[31mred\x1b[0m\x1b[2;1Hhi \x1b[0m\x1b[2;3H\x1b[?25l\x1b[?1h\x1b[?2004h\x1b[2 q",
  );
  expect(
    screenToVt({ ...screen, applicationCursorKeysMode: false, bracketedPasteMode: false }),
  ).toContain("\x1b[?1l\x1b[?2004l");
});

it("batches keystrokes and sends bounded Unicode-safe paste chunks in order", async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_data: string) => {});
  const batcher = createTerminalInputBatcher(send, vi.fn());
  batcher.push("a");
  batcher.push("\x1b[A");
  batcher.push("\x03");
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(send).toHaveBeenCalledWith("a\x1b[A\x03");
  const paste = "\x1b[200~" + "😀".repeat(6000) + "\x1b[201~";
  send.mockClear();
  batcher.push(paste);
  await vi.runAllTimersAsync();
  const chunks = send.mock.calls.map(([data]) => data);
  expect(chunks.join("")).toBe(paste);
  expect(
    chunks.every(
      (data) =>
        new TextEncoder().encode(data).length <= 16 * 1024 && !/[\uD800-\uDBFF]$/.test(data),
    ),
  ).toBe(true);
  batcher.dispose();
});

it("waits for acknowledgement, bounds queued input, and discards keys on release", async () => {
  vi.useFakeTimers();
  let acknowledge: () => void = () => {};
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const error = vi.fn();
  const batcher = createTerminalInputBatcher(send, error);
  batcher.push("a");
  await vi.advanceTimersByTimeAsync(20);
  batcher.push("b");
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(1);
  batcher.push("x".repeat(64 * 1024));
  expect(error).toHaveBeenCalledTimes(1);
  batcher.dispose();
  acknowledge();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});
