import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class BootElement extends EventTarget {
  children: BootElement[] = [];
  textContent = "";
  attributes = new Map<string, string>();

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(child: BootElement) {
    this.children.push(child);
  }

  replaceChildren(...children: BootElement[]) {
    this.children = children;
  }

  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join(" ");
  }
}

describe("app startup failures", () => {
  let bootShell: BootElement | null;

  beforeEach(() => {
    vi.resetModules();
    bootShell = new BootElement("div");
    vi.stubGlobal("document", {
      getElementById: () => bootShell,
      createElement: (tagName: string) => new BootElement(tagName),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("brands the replacement boot shell for Dulli before startup", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD_BRAND", "dulli");
    vi.doMock("./main", () => ({ startup: Promise.resolve() }));

    await import("./bootstrap");
    await vi.dynamicImportSettled();

    expect(document.title).toBe("T3 Dulli");
    expect(bootShell?.attributes.get("aria-label")).toBe("T3 Dulli splash screen");
    expect(bootShell?.attributes.get("alt")).toBe("T3 Dulli");
  });

  afterEach(() => {
    vi.doUnmock("./main");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});
