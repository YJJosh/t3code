const { withAppBuildGradle } = require("expo/config-plugins");

// Signs Android release builds with the keystore referenced by the
// T3CODE_ANDROID_RELEASE_* environment variables, replacing the Expo
// template's debug-keystore fallback. Without T3CODE_ANDROID_RELEASE_KEYSTORE
// the plugin is a no-op so local prebuilds keep the debug default. The same
// variables must still be set when Gradle runs: the patched build.gradle
// reads them through System.getenv so no secret lands in the file.
const REQUIRED_ENV = [
  "T3CODE_ANDROID_RELEASE_KEYSTORE",
  "T3CODE_ANDROID_RELEASE_KEYSTORE_PASSWORD",
  "T3CODE_ANDROID_RELEASE_KEY_ALIAS",
  "T3CODE_ANDROID_RELEASE_KEY_PASSWORD",
];

const RELEASE_SIGNING_CONFIG = `signingConfigs {
        release {
            storeFile file(System.getenv("T3CODE_ANDROID_RELEASE_KEYSTORE"))
            storePassword System.getenv("T3CODE_ANDROID_RELEASE_KEYSTORE_PASSWORD")
            keyAlias System.getenv("T3CODE_ANDROID_RELEASE_KEY_ALIAS")
            keyPassword System.getenv("T3CODE_ANDROID_RELEASE_KEY_PASSWORD")
        }`;

module.exports = function withAndroidReleaseSigning(config) {
  if (!process.env.T3CODE_ANDROID_RELEASE_KEYSTORE?.trim()) {
    return config;
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Android release signing requires these environment variables: ${missing.join(", ")}.`,
    );
  }

  return withAppBuildGradle(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;

    const releaseBuildTypeFallback = /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!releaseBuildTypeFallback.test(contents)) {
      throw new Error(
        "Could not find the release build type's debug signing fallback in android/app/build.gradle.",
      );
    }
    contents = contents.replace(releaseBuildTypeFallback, "$1signingConfig signingConfigs.release");

    const signingConfigsBlock = /signingConfigs\s*\{/;
    if (!signingConfigsBlock.test(contents)) {
      throw new Error("Could not find the signingConfigs block in android/app/build.gradle.");
    }
    contents = contents.replace(signingConfigsBlock, RELEASE_SIGNING_CONFIG);

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
