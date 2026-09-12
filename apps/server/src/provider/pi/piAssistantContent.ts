export type PiAssistantStreamKind = "assistant_text" | "reasoning_text";

export interface PiAssistantContentDelta {
  readonly streamKind: PiAssistantStreamKind;
  readonly delta: string;
  readonly contentIndex?: number;
}

interface PiAssistantBlock {
  readonly streamKind: PiAssistantStreamKind;
  readonly contentIndex?: number;
  readonly content: string;
  readonly emitted: boolean;
  readonly ended: boolean;
}

interface PiAssistantStream {
  readonly content: string;
  readonly lastBlockKey: string | undefined;
}

export interface PiAssistantContentState {
  readonly blocks: ReadonlyMap<string, PiAssistantBlock>;
  readonly streams: Readonly<Record<PiAssistantStreamKind, PiAssistantStream>>;
  readonly legacyBlockCounts: Readonly<Record<PiAssistantStreamKind, number>>;
}

export interface PiAssistantSnapshotBlock {
  readonly streamKind: PiAssistantStreamKind;
  readonly contentIndex: number;
  readonly content: string;
}

export interface PiAssistantBlockEvent {
  readonly type:
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end";
  readonly contentIndex?: number;
  readonly delta?: string;
  readonly content?: string;
}

export function makePiAssistantContentState(): PiAssistantContentState {
  return {
    blocks: new Map(),
    streams: {
      assistant_text: { content: "", lastBlockKey: undefined },
      reasoning_text: { content: "", lastBlockKey: undefined },
    },
    legacyBlockCounts: { assistant_text: 0, reasoning_text: 0 },
  };
}

function streamKindForEvent(type: PiAssistantBlockEvent["type"]): PiAssistantStreamKind {
  return type.startsWith("thinking_") ? "reasoning_text" : "assistant_text";
}

function blockKey(
  streamKind: PiAssistantStreamKind,
  contentIndex: number | undefined,
  legacyBlockCount: number,
): string {
  return contentIndex === undefined
    ? `legacy:${streamKind}:${legacyBlockCount}`
    : `index:${contentIndex}`;
}

function appendBlockContent(
  state: PiAssistantContentState,
  key: string,
  block: PiAssistantBlock,
  appended: string,
  ended: boolean,
): {
  readonly state: PiAssistantContentState;
  readonly deltas: ReadonlyArray<PiAssistantContentDelta>;
} {
  const blocks = new Map(state.blocks);
  const nextBlock = { ...block, content: block.content + appended, ended };
  const stream = state.streams[block.streamKind];

  if (!appended || (block.emitted && stream.lastBlockKey !== key)) {
    blocks.set(key, nextBlock);
    return { state: { ...state, blocks }, deltas: [] };
  }

  const boundary =
    block.emitted || stream.content.length === 0
      ? ""
      : stream.content.endsWith("\n\n")
        ? ""
        : stream.content.endsWith("\n")
          ? "\n"
          : "\n\n";
  const delta = boundary + appended;
  blocks.set(key, { ...nextBlock, emitted: true });
  return {
    state: {
      ...state,
      blocks,
      streams: {
        ...state.streams,
        [block.streamKind]: {
          content: stream.content + delta,
          lastBlockKey: key,
        },
      },
    },
    deltas: [
      {
        streamKind: block.streamKind,
        delta,
        ...(block.contentIndex !== undefined ? { contentIndex: block.contentIndex } : {}),
      },
    ],
  };
}

/** Assemble one indexed Pi block event into append-only canonical deltas. */
export function applyPiAssistantBlockEvent(
  state: PiAssistantContentState,
  event: PiAssistantBlockEvent,
): {
  readonly state: PiAssistantContentState;
  readonly deltas: ReadonlyArray<PiAssistantContentDelta>;
} {
  const streamKind = streamKindForEvent(event.type);
  const contentIndex =
    typeof event.contentIndex === "number" &&
    Number.isInteger(event.contentIndex) &&
    event.contentIndex >= 0
      ? event.contentIndex
      : undefined;
  let legacyBlockCount = state.legacyBlockCounts[streamKind];
  let key = blockKey(streamKind, contentIndex, legacyBlockCount);
  let existing = state.blocks.get(key);
  if (contentIndex === undefined && event.type.endsWith("_start") && existing?.ended) {
    legacyBlockCount += 1;
    key = blockKey(streamKind, contentIndex, legacyBlockCount);
    existing = state.blocks.get(key);
  }
  if (existing?.streamKind !== undefined && existing.streamKind !== streamKind) {
    return { state, deltas: [] };
  }
  const block =
    existing ??
    ({
      streamKind,
      ...(contentIndex !== undefined ? { contentIndex } : {}),
      content: "",
      emitted: false,
      ended: false,
    } satisfies PiAssistantBlock);
  if (block.ended) return { state, deltas: [] };

  if (event.type.endsWith("_start")) {
    if (existing) return { state, deltas: [] };
    const blocks = new Map(state.blocks);
    blocks.set(key, block);
    return {
      state: {
        ...state,
        blocks,
        legacyBlockCounts:
          contentIndex === undefined
            ? { ...state.legacyBlockCounts, [streamKind]: legacyBlockCount }
            : state.legacyBlockCounts,
      },
      deltas: [],
    };
  }

  if (event.type.endsWith("_delta")) {
    return typeof event.delta === "string"
      ? appendBlockContent(state, key, block, event.delta, false)
      : { state, deltas: [] };
  }

  if (typeof event.content !== "string" || !event.content.startsWith(block.content)) {
    const blocks = new Map(state.blocks);
    blocks.set(key, { ...block, ended: true });
    return { state: { ...state, blocks }, deltas: [] };
  }
  return appendBlockContent(state, key, block, event.content.slice(block.content.length), true);
}

/**
 * Reconcile a legacy cumulative or final authoritative snapshot. The runtime
 * contract is append-only, so only an exact prefix extension is representable.
 */
export function applyPiAssistantSnapshot(
  state: PiAssistantContentState,
  snapshot: Readonly<Record<PiAssistantStreamKind, string>> & {
    readonly blocks?: ReadonlyArray<PiAssistantSnapshotBlock>;
  },
): {
  readonly state: PiAssistantContentState;
  readonly deltas: ReadonlyArray<PiAssistantContentDelta>;
} {
  const reconcileStream = (
    currentState: PiAssistantContentState,
    streamKind: PiAssistantStreamKind,
  ) => {
    const current = currentState.streams[streamKind];
    const authoritative = snapshot[streamKind];
    if (
      !authoritative.startsWith(current.content) ||
      authoritative.length === current.content.length
    ) {
      return { state: currentState, delta: undefined };
    }
    return {
      state: {
        ...currentState,
        streams: {
          ...currentState.streams,
          [streamKind]: { content: authoritative, lastBlockKey: current.lastBlockKey },
        },
      },
      delta: { streamKind, delta: authoritative.slice(current.content.length) },
    };
  };

  const reasoning = reconcileStream(state, "reasoning_text");
  const text = reconcileStream(reasoning.state, "assistant_text");
  const acceptedKinds = new Set<PiAssistantStreamKind>();
  for (const streamKind of ["reasoning_text", "assistant_text"] as const) {
    const authoritative = snapshot[streamKind];
    const current = state.streams[streamKind].content;
    if (authoritative.startsWith(current)) acceptedKinds.add(streamKind);
  }

  let hydratedState = text.state;
  if (snapshot.blocks && acceptedKinds.size > 0) {
    const blocks = new Map(hydratedState.blocks);
    const lastBlockKeys: Partial<Record<PiAssistantStreamKind, string>> = {};
    for (const block of snapshot.blocks) {
      if (!acceptedKinds.has(block.streamKind)) continue;
      const key = blockKey(block.streamKind, block.contentIndex, 0);
      blocks.set(key, {
        ...block,
        emitted: block.content.length > 0,
        ended: false,
      });
      if (block.content.length > 0) lastBlockKeys[block.streamKind] = key;
    }
    hydratedState = {
      ...hydratedState,
      blocks,
      streams: {
        assistant_text: {
          ...hydratedState.streams.assistant_text,
          lastBlockKey:
            lastBlockKeys.assistant_text ?? hydratedState.streams.assistant_text.lastBlockKey,
        },
        reasoning_text: {
          ...hydratedState.streams.reasoning_text,
          lastBlockKey:
            lastBlockKeys.reasoning_text ?? hydratedState.streams.reasoning_text.lastBlockKey,
        },
      },
    };
  }

  return {
    state: hydratedState,
    deltas: [reasoning.delta, text.delta].filter(
      (delta): delta is PiAssistantContentDelta => delta !== undefined,
    ),
  };
}
