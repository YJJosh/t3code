import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { phoneConnections } from "./phoneConnections";

const environmentId = EnvironmentId.make("own-server");
function route(connectionId: string) {
  return {
    target: new BearerConnectionTarget({ environmentId, connectionId, label: "Own server" }),
    profile: new BearerConnectionProfile({
      environmentId,
      connectionId,
      label: "Own server",
      httpBaseUrl: "http://host:13773",
      wsBaseUrl: "ws://host:13773",
    }),
    credential: {
      connectionId,
      credential: new BearerConnectionCredential({ token: "test-credential" }),
    },
  };
}

describe("phone connection selection", () => {
  it("uses one paired direct route per environment, excluding relay routes and disabled or removed credentials", () => {
    const direct = route("direct");
    const fallback = route("fallback");
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [
        new RelayConnectionTarget({ environmentId, label: "Relay" }),
        direct.target,
        fallback.target,
      ],
      profiles: [direct.profile, fallback.profile],
      credentials: [direct.credential, fallback.credential],
    };
    expect(phoneConnections(document)).toEqual([
      {
        environmentId,
        httpBaseUrl: "http://host:13773",
        wsBaseUrl: "ws://host:13773",
        token: "test-credential",
      },
    ]);
    expect(phoneConnections({ ...document, disabledEnvironmentIds: [environmentId] })).toEqual([]);
    expect(phoneConnections({ ...document, credentials: [] })).toEqual([]);
    expect(
      phoneConnections({
        ...document,
        profiles: document.profiles.map(
          (profile) => new BearerConnectionProfile({ ...profile, authorization: "t3-connect" }),
        ),
      }),
    ).toEqual([]);
  });
});
