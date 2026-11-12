import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  ServerConfig,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

const capabilities = Schema.Struct({
  shellThreadFamilies: ServerConfig.fields.shellThreadFamilies,
  shellOlderSettled: ServerConfig.fields.shellOlderSettled,
});
const encodeCapabilities = Schema.encodeSync(capabilities);
const decodeCapabilities = Schema.decodeUnknownSync(capabilities);
const encodeSubscription = Schema.encodeSync(OrchestrationV2SubscribeShellInput);
const decodeSubscription = Schema.decodeUnknownSync(OrchestrationV2SubscribeShellInput);
const shellCodec = Schema.toCodecJson(OrchestrationV2ShellStreamItem);
const encodeShell = Schema.encodeSync(shellCodec);
const decodeShell = Schema.decodeUnknownSync(shellCodec);

// Kotlin consumes the same wire fixture; removed/renamed optional fields must not silently disappear.
it("keeps the native phone shell fixture compatible with current contracts", () => {
  const fixture = JSON.parse(
    NodeFS.readFileSync(
      new URL(
        "../../../modules/t3-agent-notifications/android/src/test/resources/phone-shell.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(fixture.methods).toEqual({
    config: WS_METHODS.serverGetConfig,
    shell: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  });
  expect(encodeCapabilities(decodeCapabilities(fixture.serverConfig))).toEqual(
    fixture.serverConfig,
  );
  expect(encodeSubscription(decodeSubscription(fixture.subscription))).toEqual(
    fixture.subscription,
  );
  for (const item of fixture.items) {
    expect(encodeShell(decodeShell(item))).toEqual(item);
  }
});
