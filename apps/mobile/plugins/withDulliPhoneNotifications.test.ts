import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { applyDulliPhoneManifest, backupRules } = require("./withDulliPhoneNotifications.cjs") as {
  readonly backupRules: Record<string, string>;
  readonly applyDulliPhoneManifest: <T>(brand: string, manifest: T) => T;
};

function manifest() {
  return {
    "uses-permission": [{ $: { "android:name": "android.permission.RECEIVE_BOOT_COMPLETED" } }],
    application: [
      {
        service: [
          { $: { "android:name": "expo.modules.t3agentnotifications.AgentMessagingService" } },
        ],
        receiver: [],
      },
    ],
  };
}

describe("Dulli phone service manifest", () => {
  it("leaves upstream builds unchanged, including their relay service", () => {
    const source = manifest();
    const before = structuredClone(source);
    expect(applyDulliPhoneManifest("t3code", source)).toEqual(before);
    const switched = applyDulliPhoneManifest("t3code", applyDulliPhoneManifest("dulli", source));
    expect(switched.application[0]?.service).toEqual(before.application[0]?.service);
    expect(switched.application[0]?.receiver).toEqual([]);
    expect(switched["uses-permission"].map((entry) => entry.$["android:name"])).not.toContain(
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    );
    expect(switched["uses-permission"].map((entry) => entry.$["android:name"])).not.toContain(
      "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    );
  });

  it("adds no empty lists to upstream builds that have none", () => {
    // An undefined list renders as a nameless <service/>, which fails the Android manifest merge.
    const bare = { application: [{ $: {} }] };
    expect(applyDulliPhoneManifest("t3code", bare)).toStrictEqual({ application: [{ $: {} }] });
  });

  it("adds special-use and boot declarations only once while retaining the relay path", () => {
    const once = applyDulliPhoneManifest("dulli", manifest());
    const before = structuredClone(once);
    expect(applyDulliPhoneManifest("dulli", once)).toEqual(before);
    expect(once["uses-permission"].map((entry) => entry.$["android:name"])).toEqual([
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
      "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    ]);
    expect(once.application[0]?.service).toEqual([
      { $: { "android:name": "expo.modules.t3agentnotifications.AgentMessagingService" } },
      expect.objectContaining({
        $: expect.objectContaining({
          "android:name": "expo.modules.t3agentnotifications.PhoneConnectionService",
          "android:foregroundServiceType": "specialUse",
          "android:stopWithTask": "false",
        }),
      }),
    ]);
    expect(once.application[0]).toEqual(
      expect.objectContaining({
        $: expect.objectContaining({
          "android:fullBackupContent": "@xml/dulli_backup_rules",
          "android:dataExtractionRules": "@xml/dulli_data_extraction_rules",
        }),
      }),
    );
    expect(once.application[0]?.receiver).toEqual([
      expect.objectContaining({
        "intent-filter": [
          {
            action: [
              { $: { "android:name": "android.intent.action.BOOT_COMPLETED" } },
              { $: { "android:name": "android.intent.action.MY_PACKAGE_REPLACED" } },
            ],
          },
        ],
      }),
    ]);
  });
});

it("excludes native state and SecureStore from cloud and device-transfer backups", async () => {
  const { XML } = require("expo/config-plugins");
  const backup = await XML.parseXMLAsync(backupRules.dulli_backup_rules);
  const extraction = await XML.parseXMLAsync(backupRules.dulli_data_extraction_rules);
  for (const rules of [
    backup["full-backup-content"],
    extraction["data-extraction-rules"]["cloud-backup"][0],
    extraction["data-extraction-rules"]["device-transfer"][0],
  ]) {
    expect(rules.exclude).toEqual(
      ["SecureStore", "t3-phone-connection.xml", "t3-agent-notifications.xml"].map((name) => ({
        $: { domain: "sharedpref", path: name },
      })),
    );
  }
});
