const { withAndroidManifest } = require("expo/config-plugins");

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
  return withAndroidManifest(config, (next) => {
    applyDulliPhoneManifest(config.extra?.appBrand, next.modResults.manifest);
    return next;
  });
};
module.exports.applyDulliPhoneManifest = applyDulliPhoneManifest;
