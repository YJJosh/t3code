export type PiAssistantStreamKind = "assistant_text" | "reasoning_text";

export interface PiAssistantContentDelta {
  readonly streamKind: PiAssistantStreamKind;
  readonly delta: string;
  readonly contentIndex?: number;
  /** True for the first emitted content from one native Pi content block. */
  readonly startsBlock?: boolean;
  /** Separator added only to the flattened per-stream accumulator. */
  readonly blockBoundary?: string;
  /** An explicit native tool/work block occurred before this content block. */
  readonly workBoundaryBefore?: boolean;
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
  readonly workBoundaryBefore?: boolean;
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

  const startsBlock = !block.emitted;
  const boundary =
    !startsBlock || stream.content.length === 0
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
        ...(startsBlock ? { startsBlock: true } : {}),
        ...(boundary ? { blockBoundary: boundary } : {}),
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
 * Reconcile a legacy cumulative or final authoritative snapshot. Indexed
 * blocks are reconciled in native order so snapshot-only delivery retains the
 * same boundaries as live streaming. Non-prefix corrections are not
 * representable by the append-only runtime contract and are ignored.
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
  // Legacy deltas have no indices. Their final snapshot must extend the
  // accumulated streams, not replay the same text as new indexed blocks.
  const hasUnindexedBlocks = Array.from(state.blocks.values()).some(
    (block) => block.contentIndex === undefined,
  );
  if (snapshot.blocks && !hasUnindexedBlocks) {
    let currentState = state;
    const deltas: PiAssistantContentDelta[] = [];
    for (const snapshotBlock of snapshot.blocks) {
      const key = blockKey(snapshotBlock.streamKind, snapshotBlock.contentIndex, 0);
      const existing = currentState.blocks.get(key);
      if (existing?.streamKind !== undefined && existing.streamKind !== snapshotBlock.streamKind) {
        continue;
      }
      const block =
        existing ??
        ({
          streamKind: snapshotBlock.streamKind,
          contentIndex: snapshotBlock.contentIndex,
          content: "",
          emitted: false,
          ended: false,
        } satisfies PiAssistantBlock);
      if (!snapshotBlock.content.startsWith(block.content)) continue;
      const result = appendBlockContent(
        currentState,
        key,
        block,
        snapshotBlock.content.slice(block.content.length),
        block.ended,
      );
      currentState = result.state;
      deltas.push(
        ...result.deltas.map((delta) =>
          snapshotBlock.workBoundaryBefore && delta.startsBlock
            ? { ...delta, workBoundaryBefore: true }
            : delta,
        ),
      );
    }
    return { state: currentState, deltas };
  }

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
  let hydratedState = text.state;
  if (snapshot.blocks) {
    // Once a legacy stream agrees with the snapshot, adopt its block indices
    // so later indexed deltas/endings extend existing text instead of replaying it.
    const acceptedKinds = new Set<PiAssistantStreamKind>();
    for (const streamKind of ["assistant_text", "reasoning_text"] as const) {
      if (snapshot[streamKind].startsWith(state.streams[streamKind].content))
        acceptedKinds.add(streamKind);
    }
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
    for (const [key, block] of blocks) {
      if (block.contentIndex === undefined && lastBlockKeys[block.streamKind] !== undefined) {
        blocks.delete(key);
      }
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
