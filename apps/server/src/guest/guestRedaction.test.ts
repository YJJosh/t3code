import {
  ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { guestHistoryPage, guestStreamItem } from "./guestRedaction.ts";

const SESSION_FILE = "/home/owner/.pi/agent/sessions/owner-session.jsonl";
const PROFILE_WARNING = "Profile owner-private-profile no longer exists.";
const nativeRef = { driver: "pi", nativeId: SESSION_FILE, strength: "strong" };
const profileError = {
  type: "error",
  title: ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE,
  failure: { class: "provider_error", message: PROFILE_WARNING, code: null, retryable: null },
};

// Only the records the scrub reads; the rest of each record passes through untouched.
const projection = {
  thread: { modelSelection: { instanceId: "pi", model: "m" }, branch: null, worktreePath: null },
  runs: [],
  attempts: [{ id: "attempt-1", nativeThreadId: SESSION_FILE }],
  subagents: [],
  providerSessions: [],
  providerThreads: [
    { id: "pt-1", nativeThreadRef: nativeRef, nativeConversationHeadRef: nativeRef },
  ],
  providerTurns: [{ id: "turn-1", nativeTurnRef: nativeRef, nativeThreadRef: nativeRef }],
  turnItems: [profileError],
  visibleTurnItems: [{ item: profileError }],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
} as unknown as OrchestrationV2ThreadProjection;

const event = (type: string, payload: unknown) =>
  ({ kind: "event", sequence: 1, event: { type, payload } }) as OrchestrationV2ThreadStreamItem;

it("keeps native session paths and session-open failure text away from the guest", () => {
  const sent = [
    guestStreamItem({ kind: "snapshot", snapshotSequence: 1, projection }),
    guestStreamItem(event("provider-thread.updated", projection.providerThreads[0])),
    guestStreamItem(event("provider-turn.updated", projection.providerTurns[0])),
    guestStreamItem(event("run-attempt.updated", projection.attempts[0])),
    guestStreamItem(event("turn-item.updated", profileError)),
    guestHistoryPage({
      snapshotSequence: 1,
      items: [{ item: profileError }],
      nextCursor: null,
      hasMoreHistory: false,
    } as never),
  ];
  const wire = JSON.stringify(sent);
  assert.notInclude(wire, SESSION_FILE);
  assert.notInclude(wire, "owner-private-profile");
  assert.include(wire, ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE);
});
