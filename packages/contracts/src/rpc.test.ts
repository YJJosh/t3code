import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WS_METHODS, WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

const decodeServerConfigSubscription = Schema.decodeUnknownSync(
  WsSubscribeServerConfigRpc.payloadSchema,
);

describe("fork RPC compatibility", () => {
  it.each([
    WS_METHODS.providerControlTask,
    WS_METHODS.backgroundTerminalsControl,
    WS_METHODS.subscribeBackgroundTerminalEvents,
    WS_METHODS.providerAuthStart,
    WS_METHODS.providerInstallStart,
    WS_METHODS.pullRequestsSubscribeRefreshes,
  ])("keeps %s registered alongside upstream methods", (method) => {
    expect(WsRpcGroup.requests.has(method)).toBe(true);
  });
});

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeServerConfigSubscription({ environmentThemes: true });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeServerConfigSubscription({});
    expect(decoded).toEqual({});
  });
});
