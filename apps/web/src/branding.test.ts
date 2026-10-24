import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

beforeEach(() => {
  vi.stubEnv("VITE_DESKTOP_BUILD_BRAND", "");
  vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("Dulli branding", () => {
  it("uses injected desktop branding ahead of build branding", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD_BRAND", "dulli");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "T3 Custom Brand",
            stageLabel: "Nightly",
            displayName: "T3 Custom Brand (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Custom Brand");
    expect(branding.APP_WORDMARK_LABEL).toBe("Custom Brand");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Custom Brand (Nightly)");
  });

  it("uses source-level Dulli branding for desktop builds", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD_BRAND", " DULLI ");

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Dulli");
    expect(branding.APP_WORDMARK_LABEL).toBe("Dulli");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Dulli");
  });
});
