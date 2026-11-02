const fs = require("node:fs/promises");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

function applyDulliPhoneManifest(brand, manifest) {
  if (brand !== "dulli") {
    manifest["uses-permission"] = manifest["uses-permission"]?.filter(
      (entry) =>
        ![
          "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
          "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        ].includes(entry.$["android:name"]),
    );
    const application = manifest.application[0];
    if (application.$?.["android:fullBackupContent"] === "@xml/dulli_backup_rules") {
      application.$["android:fullBackupContent"] = "@xml/secure_store_backup_rules";
      application.$["android:dataExtractionRules"] = "@xml/secure_store_data_extraction_rules";
    }
    application.service = application.service?.filter(
      (entry) =>
        entry.$["android:name"] !== "expo.modules.t3agentnotifications.PhoneConnectionService",
    );
    application.receiver = application.receiver?.filter(
      (entry) =>
        entry.$["android:name"] !== "expo.modules.t3agentnotifications.PhoneConnectionBootReceiver",
    );
    return manifest;
  }
  const permissions = (manifest["uses-permission"] ??= []);
  for (const name of [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  ]) {
    if (!permissions.some((entry) => entry.$["android:name"] === name)) {
      permissions.push({ $: { "android:name": name } });
    }
  }
  const application = manifest.application[0];
  application.$ ??= {};
  application.$["android:fullBackupContent"] = "@xml/dulli_backup_rules";
  application.$["android:dataExtractionRules"] = "@xml/dulli_data_extraction_rules";
  const services = (application.service ??= []);
  const serviceName = "expo.modules.t3agentnotifications.PhoneConnectionService";
  if (!services.some((entry) => entry.$["android:name"] === serviceName)) {
    services.push({
      $: {
        "android:name": serviceName,
        "android:exported": "false",
        "android:stopWithTask": "false",
        "android:foregroundServiceType": "specialUse",
      },
      property: [
        {
          $: {
            "android:name": "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
            "android:value":
              "Opt-in persistent connection to a self-hosted coding agent server for timely approvals, questions and task completion on a sideloaded app without a push relay",
          },
        },
      ],
    });
  }
  const receivers = (application.receiver ??= []);
  const receiverName = "expo.modules.t3agentnotifications.PhoneConnectionBootReceiver";
  if (!receivers.some((entry) => entry.$["android:name"] === receiverName)) {
    receivers.push({
      $: { "android:name": receiverName, "android:exported": "false" },
      "intent-filter": [
        {
          action: [
            { $: { "android:name": "android.intent.action.BOOT_COMPLETED" } },
            { $: { "android:name": "android.intent.action.MY_PACKAGE_REPLACED" } },
          ],
        },
      ],
    });
  }
  return manifest;
}

module.exports = function withDulliPhoneNotifications(config) {
  if (config.extra?.appBrand === "dulli") {
    config = withDangerousMod(config, [
      "android",
      async (next) => {
        const directory = path.join(next.modRequest.platformProjectRoot, "app/src/main/res/xml");
        await fs.mkdir(directory, { recursive: true });
        for (const [name, content] of Object.entries(backupRules)) {
          await fs.writeFile(path.join(directory, `${name}.xml`), content);
        }
        return next;
      },
    ]);
  }
  return withAndroidManifest(config, (next) => {
    applyDulliPhoneManifest(config.extra?.appBrand, next.modResults.manifest);
    return next;
  });
};
module.exports.applyDulliPhoneManifest = applyDulliPhoneManifest;

const exclusions = ["SecureStore", "t3-phone-connection.xml", "t3-agent-notifications.xml"]
  .map((name) => `<exclude domain="sharedpref" path="${name}"/>`)
  .join("\n");
const sharedPreferences = `<include domain="sharedpref" path="."/>\n${exclusions}`;
const backupRules = {
  dulli_backup_rules: `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>${sharedPreferences}</full-backup-content>`,
  dulli_data_extraction_rules: `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
<cloud-backup>${sharedPreferences}</cloud-backup>
<device-transfer>${sharedPreferences}</device-transfer>
</data-extraction-rules>`,
};
module.exports.backupRules = backupRules;
