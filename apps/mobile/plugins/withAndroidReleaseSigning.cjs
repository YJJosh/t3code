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

function applyAndroidReleaseSigning(contents) {
  const releaseBuildTypeFallback =
    /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  const releaseBuildTypeConfigured =
    /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig signingConfigs\.release/.test(
      contents,
    );
  if (releaseBuildTypeFallback.test(contents)) {
    contents = contents.replace(releaseBuildTypeFallback, "$1signingConfig signingConfigs.release");
  } else if (!releaseBuildTypeConfigured) {
    throw new Error(
      "Could not find the release build type's signing configuration in android/app/build.gradle.",
    );
  }

  if (!contents.includes('System.getenv("T3CODE_ANDROID_RELEASE_KEYSTORE")')) {
    const signingConfigsBlock = /signingConfigs\s*\{/;
    if (!signingConfigsBlock.test(contents)) {
      throw new Error("Could not find the signingConfigs block in android/app/build.gradle.");
    }
    contents = contents.replace(signingConfigsBlock, RELEASE_SIGNING_CONFIG);
  }

  return contents;
}

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
    nextConfig.modResults.contents = applyAndroidReleaseSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
};

module.exports.applyAndroidReleaseSigning = applyAndroidReleaseSigning;
