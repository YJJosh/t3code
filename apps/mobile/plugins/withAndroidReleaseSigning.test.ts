import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { applyAndroidReleaseSigning } = require("./withAndroidReleaseSigning.cjs") as {
  readonly applyAndroidReleaseSigning: (contents: string) => string;
};

const GRADLE_TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;

describe("withAndroidReleaseSigning", () => {
  it("only changes the release build type and is idempotent", () => {
    const once = applyAndroidReleaseSigning(GRADLE_TEMPLATE);
    const twice = applyAndroidReleaseSigning(once);

    expect(twice).toBe(once);
    expect(once).toContain(`debug {
            signingConfig signingConfigs.debug
        }`);
    expect(once).toContain(`release {
            signingConfig signingConfigs.release
        }`);
    expect(once.match(/T3CODE_ANDROID_RELEASE_KEYSTORE"/g)).toHaveLength(1);
  });
});
