const { withSettingsGradle } = require("expo/config-plugins");

const USE_EXPO_MODULES = "expoAutolinking.useExpoModules()";

// Keeps the given Expo modules out of the Android build, for builds that cannot run them.
function applyAndroidAutolinkingExclude(contents, packages) {
  const exclude = `expoAutolinking.exclude = ${JSON.stringify(packages)}`;
  const withoutPrevious = contents.replace(/^expoAutolinking\.exclude = .*\n/m, "");
  if (!withoutPrevious.includes(USE_EXPO_MODULES)) {
    throw new Error(`Could not find ${USE_EXPO_MODULES} in android/settings.gradle.`);
  }
  return withoutPrevious.replace(USE_EXPO_MODULES, `${exclude}\n${USE_EXPO_MODULES}`);
}

module.exports = function withAndroidAutolinkingExclude(config, packages) {
  return withSettingsGradle(config, (nextConfig) => {
    nextConfig.modResults.contents = applyAndroidAutolinkingExclude(
      nextConfig.modResults.contents,
      packages,
    );
    return nextConfig;
  });
};

module.exports.applyAndroidAutolinkingExclude = applyAndroidAutolinkingExclude;
