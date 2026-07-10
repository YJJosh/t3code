import type { SubagentActivityEntry, SubagentRunEntry } from "./subagentRuntime.ts";

function activityRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function activityMessageRole(entry: SubagentActivityEntry): string | null {
  const message = activityRecord(entry.data["message"]);
  return typeof message?.["role"] === "string" ? message["role"] : null;
}

function activityMessageBlocks(entry: SubagentActivityEntry): ReadonlyArray<unknown> {
  const message = activityRecord(entry.data["message"]);
  return Array.isArray(message?.["content"]) ? message["content"] : [];
}

function activityMessageText(entry: SubagentActivityEntry): ReadonlyArray<string> {
  return activityMessageBlocks(entry).flatMap((value) => {
    const block = activityRecord(value);
    const text = block?.["text"];
    return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
  });
}

function hasReadableActivityValue(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasReadableActivityValue(item, depth + 1));
  }
  const record = activityRecord(value);
  if (record === null) {
    return false;
  }
  return ["text", "thinking", "delta", "content", "message", "summary", "error"].some(
    (key) => key in record && hasReadableActivityValue(record[key], depth + 1),
  );
}

function isInitialTaskMessage(
  entry: SubagentActivityEntry,
  task: string,
  assistantSeen: boolean,
): boolean {
  if (assistantSeen) {
    return false;
  }
  const taskText = task.trim();
  const messageText = activityMessageText(entry);
  return taskText.length === 0
    ? messageText.length > 0
    : messageText.some((text) => text.includes(taskText));
}

function matchesStructuredResult(
  value: unknown,
  expected: NonNullable<SubagentRunEntry["view"]["result"]>["result"],
): boolean {
  const result = activityRecord(value);
  return (
    expected !== undefined &&
    result !== null &&
    result["status"] === expected.status &&
    typeof result["summary"] === "string" &&
    result["summary"].trim() === expected.summary.trim() &&
    Array.isArray(result["files_changed"]) &&
    Array.isArray(result["open_questions"])
  );
}

function stripResultSuffix(
  text: string,
  expected: NonNullable<SubagentRunEntry["view"]["result"]>["result"],
): { readonly matched: boolean; readonly text: string } {
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    const suffix = text.slice(index).trim();
    try {
      if (matchesStructuredResult(JSON.parse(suffix), expected)) {
        return { matched: true, text: text.slice(0, index).trimEnd() };
      }
    } catch {
      // This opening brace was part of prose or a nested object. Try the next
      // candidate rather than guessing from repeated display text.
    }
  }
  return { matched: false, text };
}

/** Remove only the machine-readable result contract already represented by
 * the result card. Some providers return it as the entire text block; others
 * append it after a useful prose summary, which must remain in the transcript. */
function withoutStructuredResult(
  entry: SubagentActivityEntry,
  run: SubagentRunEntry,
): SubagentActivityEntry {
  const expected = run.view.result?.result;
  const message = activityRecord(entry.data["message"]);
  const content = Array.isArray(message?.["content"]) ? message["content"] : null;
  if (expected === undefined || message === null || content === null) {
    return entry;
  }

  let changed = false;
  const nextContent = content.flatMap((value) => {
    const block = activityRecord(value);
    if (block === null || typeof block["text"] !== "string") {
      return [value];
    }
    const stripped = stripResultSuffix(block["text"], expected);
    if (!stripped.matched) {
      return [value];
    }
    changed = true;
    return stripped.text.length > 0 ? [{ ...block, text: stripped.text }] : [];
  });

  return changed
    ? {
        ...entry,
        data: { ...entry.data, message: { ...message, content: nextContent } },
      }
    : entry;
}

function toolCallId(entry: SubagentActivityEntry): string | null {
  const value = entry.data["toolCallId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function repeatsCurrentProgress(entry: SubagentActivityEntry, run: SubagentRunEntry): boolean {
  const progressNote = run.view.progressNote?.trim();
  const args = activityRecord(entry.data["args"]);
  const activityNote = args?.["note"];
  return (
    entry.kind === "child_tool" &&
    entry.data["toolName"] === "progress" &&
    progressNote !== undefined &&
    progressNote.length > 0 &&
    typeof activityNote === "string" &&
    activityNote.trim() === progressNote
  );
}

function mergeToolActivity(
  previous: SubagentActivityEntry,
  next: SubagentActivityEntry,
): SubagentActivityEntry {
  return {
    ...next,
    data: {
      ...previous.data,
      ...next.data,
      // End events omit invocation arguments. Retain them so the canonical row
      // explains what the tool did instead of dumping its often-large output.
      ...(previous.data["args"] !== undefined ? { args: previous.data["args"] } : {}),
    },
  };
}

/**
 * Build the semantic transcript shown by clients from Pi's raw child event
 * lifecycle. Pi emits start/update/end envelopes (and repeats the completed
 * message on turn_end); this projection deliberately keeps one useful entry:
 *
 * - turn envelopes and streaming message deltas are transport noise;
 * - the initial user message repeats the run task already shown in the header;
 * - tool-result messages repeat the corresponding tool execution;
 * - tool start/end events collapse into one invocation row while preserving
 *   the start arguments;
 * - the latest progress tool call is represented by the current progress card;
 *   and
 * - the final JSON result is represented by the structured result card.
 *
 * Distinct assistant messages, later manager/user messages, and distinct tool
 * calls are retained even when their display text happens to be identical.
 */
export function selectSubagentTranscriptActivity(
  run: SubagentRunEntry,
): ReadonlyArray<SubagentActivityEntry> {
  const transcript: SubagentActivityEntry[] = [];
  const toolIndexes = new Map<string, number>();
  let assistantSeen = false;

  for (const entry of run.activity) {
    if (entry.kind === "child_turn") {
      continue;
    }

    if (entry.kind === "child_message") {
      if (entry.liveOnly || entry.type === "message_start" || entry.type === "message_update") {
        continue;
      }

      const role = activityMessageRole(entry);
      if (role === "user" && isInitialTaskMessage(entry, run.view.task, assistantSeen)) {
        continue;
      }
      if (role === "toolResult" || role === "tool") {
        continue;
      }
      if (role === "assistant") {
        assistantSeen = true;
        const normalized = withoutStructuredResult(entry, run);
        if (!hasReadableActivityValue(normalized.data)) {
          continue;
        }
        transcript.push(normalized);
        continue;
      }

      transcript.push(entry);
      continue;
    }

    if (entry.kind === "child_tool") {
      const callId = toolCallId(entry);
      const existingIndex = callId === null ? undefined : toolIndexes.get(callId);
      if (existingIndex !== undefined) {
        const previous = transcript[existingIndex];
        if (previous !== undefined) {
          transcript[existingIndex] = mergeToolActivity(previous, entry);
        }
      } else {
        transcript.push(entry);
        if (callId !== null) {
          toolIndexes.set(callId, transcript.length - 1);
        }
      }
      continue;
    }

    transcript.push(entry);
  }

  return transcript.filter((entry) => !repeatsCurrentProgress(entry, run));
}
