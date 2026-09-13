import * as NodeAssert from "node:assert";
import { AppUpdater } from "electron-updater";
import { describe, it } from "vite-plus/test";

import { checkForUpdatesWithDulliTransition, makeDulliGitHubFeedUrl } from "./ElectronUpdater.ts";

const STAGING_USER_ID = "50e8400-e29b-41d4-a716-446655440000";

function releasesFeed(versions: ReadonlyArray<string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${versions
  .map(
    (version) => `<entry>
  <title>${version}</title>
  <link href="https://github.com/owner/repo/releases/tag/v${version}"/>
  <content>Release ${version}</content>
</entry>`,
  )
  .join("\n")}
</feed>`;
}

interface FixtureRequestOptions {
  readonly protocol?: string | undefined;
  readonly hostname?: string | undefined;
  readonly path?: string | undefined;
  readonly headers?: Readonly<Record<string, unknown>> | undefined;
}

function requestUrl(options: FixtureRequestOptions): string {
  return `${options.protocol}//${options.hostname}${options.path}`;
}

class FixtureExecutor {
  readonly requests: Array<string> = [];
  readonly requestOptions: Array<FixtureRequestOptions> = [];
  readonly respond: (url: string) => string | null | Promise<string | null>;

  constructor(respond: (url: string) => string | null | Promise<string | null>) {
    this.respond = respond;
  }

  request(options: FixtureRequestOptions): Promise<string | null> {
    const url = requestUrl(options);
    this.requests.push(url);
    this.requestOptions.push(options);
    return Promise.resolve(this.respond(url));
  }
}

class TestAppUpdater extends AppUpdater {
  constructor(
    version: string,
    executor: FixtureExecutor,
    platform: "win32" | "darwin" | "linux" = "win32",
  ) {
    super(null, {
      version,
      name: "T3 Dulli",
      isPackaged: true,
      appUpdateConfigPath: "/unused/app-update.yml",
      userDataPath: "/unused/userdata",
      baseCachePath: "/unused/cache",
      whenReady: () => Promise.resolve(),
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined,
    });
    Reflect.set(this, "httpExecutor", executor);
    Reflect.set(this, "_testOnlyOptions", { platform });
    Reflect.set(this, "stagingUserIdPromise", { value: Promise.resolve(STAGING_USER_ID) });
    this.autoDownload = false;
    this.logger = null;
    this.setFeedURL(
      makeDulliGitHubFeedUrl({
        provider: "github",
        owner: "owner",
        repo: "repo",
      }),
    );
  }

  override quitAndInstall(): void {}

  protected override doDownloadUpdate(): Promise<Array<string>> {
    return Promise.resolve([]);
  }
}

function makeFixtureUpdater(args: {
  readonly currentVersion: string;
  readonly releases: ReadonlyArray<string>;
  readonly manifests?: Readonly<Record<string, string>>;
  readonly platform?: "win32" | "darwin" | "linux";
}) {
  const feed = releasesFeed(args.releases);
  const executor = new FixtureExecutor((url) => {
    if (url.endsWith("/releases.atom")) return feed;
    const manifest = args.manifests?.[url];
    if (manifest !== undefined) return manifest;
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  return { updater: new TestAppUpdater(args.currentVersion, executor, args.platform), executor };
}

function manifestUrl(version: string, channel: string): string {
  return `https://github.com/owner/repo/releases/download/v${version}/${channel}.yml`;
}

function versionManifest(version: string, extra = ""): string {
  return `version: ${version}\n${extra}`;
}

describe("DulliGitHubProvider", () => {
  it("selects the approved Pi then Dulli release sequence", async () => {
    const first = makeFixtureUpdater({
      currentVersion: "0.0.36-pi.2",
      releases: ["0.0.40-dulli.2", "0.0.40-pi.1", "0.0.36-pi.2"],
      manifests: {
        [manifestUrl("0.0.40-pi.1", "latest")]: versionManifest("0.0.40-pi.1"),
      },
    });
    // The shipped 0.0.36 client has the stock provider, not the migration code.
    first.updater.setFeedURL({ provider: "github", owner: "owner", repo: "repo" });
    const piResult = await first.updater.checkForUpdates();
    NodeAssert.equal(piResult?.isUpdateAvailable, true);
    NodeAssert.equal(piResult?.updateInfo.version, "0.0.40-pi.1");
    NodeAssert.equal(
      first.executor.requests.filter((url) => url.endsWith("/releases.atom")).length,
      1,
    );

    const second = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: ["0.0.40-dulli.2", "0.0.40-pi.1"],
      manifests: {
        [manifestUrl("0.0.40-dulli.2", "dulli")]: versionManifest("0.0.40-dulli.2"),
      },
    });
    second.updater.fullChangelog = true;
    second.updater.requestHeaders = { "x-fixture-header": "forwarded" };
    const dulliResult = await checkForUpdatesWithDulliTransition(second.updater);
    NodeAssert.equal(dulliResult?.isUpdateAvailable, true);
    NodeAssert.equal(dulliResult?.updateInfo.version, "0.0.40-dulli.2");
    NodeAssert.equal(dulliResult?.updateInfo.releaseNotes, "Release 0.0.40-dulli.2");
    const dulliManifestRequest = second.executor.requestOptions.find((options) =>
      requestUrl(options).endsWith("/dulli.yml"),
    );
    NodeAssert.equal(dulliManifestRequest?.headers?.["x-fixture-header"], "forwarded");
    NodeAssert.equal(second.updater.allowDowngrade, false);
  });

  it.each([
    ["win32", "dulli", "latest"],
    ["darwin", "dulli-mac", "latest-mac"],
    ["linux", "dulli-linux", "latest-linux"],
  ] as const)("uses the published latest manifest on %s", async (platform, custom, latest) => {
    const version = "0.0.40-dulli.2";
    const fixture = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: [version, "0.0.40-pi.1"],
      platform,
      manifests: { [manifestUrl(version, latest)]: versionManifest(version) },
    });

    const result = await checkForUpdatesWithDulliTransition(fixture.updater);

    NodeAssert.equal(result?.isUpdateAvailable, true);
    NodeAssert.equal(result?.updateInfo.version, version);
    NodeAssert.deepEqual(fixture.executor.requests.slice(-2), [
      manifestUrl(version, custom),
      manifestUrl(version, latest),
    ]);
  });

  it("falls back cleanly to Pi when no Dulli tag exists", async () => {
    const current = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: ["0.0.40-pi.1"],
      manifests: {
        [manifestUrl("0.0.40-pi.1", "pi")]: versionManifest("0.0.40-pi.1"),
      },
    });
    const noUpdate = await checkForUpdatesWithDulliTransition(current.updater);
    NodeAssert.equal(noUpdate?.isUpdateAvailable, false);
    NodeAssert.equal(noUpdate?.updateInfo.version, "0.0.40-pi.1");

    const future = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: ["0.0.40-pi.2", "0.0.40-pi.1"],
      manifests: {
        [manifestUrl("0.0.40-pi.2", "pi")]: versionManifest("0.0.40-pi.2"),
      },
    });
    const piUpdate = await checkForUpdatesWithDulliTransition(future.updater);
    NodeAssert.equal(piUpdate?.isUpdateAvailable, true);
    NodeAssert.equal(piUpdate?.updateInfo.version, "0.0.40-pi.2");
  });

  it("rejects same-base lower builds and lower-base Dulli releases", async () => {
    for (const [currentVersion, candidateVersion] of [
      ["0.0.40-pi.2", "0.0.40-dulli.1"],
      ["0.0.40-pi.1", "0.0.40-dulli.1"],
      ["0.0.40-pi.1", "0.0.39-dulli.99"],
      ["0.0.40-dulli.2", "0.0.40-dulli.1"],
    ] as const) {
      const fixture = makeFixtureUpdater({
        currentVersion,
        releases: [candidateVersion, currentVersion],
        manifests: {
          [manifestUrl(candidateVersion, "dulli")]: versionManifest(candidateVersion),
        },
      });
      const result = await checkForUpdatesWithDulliTransition(fixture.updater);
      NodeAssert.equal(
        result?.isUpdateAvailable,
        false,
        `${currentVersion} -> ${candidateVersion}`,
      );
      NodeAssert.equal(fixture.updater.allowDowngrade, false);
    }
  });

  it("never falls back to Pi after Dulli is installed", async () => {
    const fixture = makeFixtureUpdater({
      currentVersion: "0.0.40-dulli.2",
      releases: ["0.0.40-pi.99", "0.0.40-dulli.2"],
      manifests: {
        [manifestUrl("0.0.40-dulli.2", "dulli")]: versionManifest("0.0.40-dulli.2"),
      },
    });

    const result = await checkForUpdatesWithDulliTransition(fixture.updater);

    NodeAssert.equal(result?.isUpdateAvailable, false);
    NodeAssert.equal(result?.updateInfo.version, "0.0.40-dulli.2");
    NodeAssert.equal(
      fixture.executor.requests.some((url) => url.endsWith("/pi.yml")),
      false,
    );
  });

  it("allows normal future-base and subsequent Dulli updates without downgrade", async () => {
    for (const [currentVersion, candidateVersion] of [
      ["0.0.40-pi.1", "0.0.41-dulli.1"],
      ["0.0.40-dulli.2", "0.0.40-dulli.3"],
    ] as const) {
      const fixture = makeFixtureUpdater({
        currentVersion,
        releases: [candidateVersion, currentVersion],
        manifests: {
          [manifestUrl(candidateVersion, "dulli")]: versionManifest(candidateVersion),
        },
      });
      const result = await checkForUpdatesWithDulliTransition(fixture.updater);
      NodeAssert.equal(result?.isUpdateAvailable, true, `${currentVersion} -> ${candidateVersion}`);
      NodeAssert.equal(fixture.updater.allowDowngrade, false);
    }
  });

  it("leaves explicit nightly selection to the upstream GitHub provider", async () => {
    const fixture = makeFixtureUpdater({
      currentVersion: "0.0.40-nightly.1",
      releases: ["0.0.40-dulli.2", "0.0.40-nightly.2"],
      manifests: {
        [manifestUrl("0.0.40-nightly.2", "nightly")]: versionManifest("0.0.40-nightly.2"),
      },
    });
    fixture.updater.channel = "nightly";
    fixture.updater.allowDowngrade = false;

    const result = await checkForUpdatesWithDulliTransition(fixture.updater);

    NodeAssert.equal(result?.isUpdateAvailable, true);
    NodeAssert.equal(result?.updateInfo.version, "0.0.40-nightly.2");
    NodeAssert.equal(
      fixture.executor.requests.some((url) => url.endsWith("/dulli.yml")),
      false,
    );
  });

  it("keeps upstream support and staging decisions authoritative", async () => {
    const unsupported = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: ["0.0.40-dulli.2"],
      manifests: {
        [manifestUrl("0.0.40-dulli.2", "dulli")]: versionManifest(
          "0.0.40-dulli.2",
          "minimumSystemVersion: 9999.0.0\n",
        ),
      },
    });
    const unsupportedResult = await checkForUpdatesWithDulliTransition(unsupported.updater);
    NodeAssert.equal(unsupportedResult?.isUpdateAvailable, false);

    const stagedOut = makeFixtureUpdater({
      currentVersion: "0.0.40-pi.1",
      releases: ["0.0.40-dulli.2"],
      manifests: {
        [manifestUrl("0.0.40-dulli.2", "dulli")]: versionManifest("0.0.40-dulli.2"),
      },
    });
    let rolloutChecks = 0;
    const stagedOutCallback = () => {
      rolloutChecks += 1;
      return false;
    };
    stagedOut.updater.isUserWithinRollout = stagedOutCallback;
    const stagedResult = await checkForUpdatesWithDulliTransition(stagedOut.updater);
    NodeAssert.equal(stagedResult?.isUpdateAvailable, false);
    NodeAssert.equal(rolloutChecks, 1);
    NodeAssert.strictEqual(stagedOut.updater.isUserWithinRollout, stagedOutCallback);
  });

  it("does not fall back on network or malformed-feed failures and restores check hooks", async () => {
    for (const [response, expectedError] of [
      [() => Promise.reject(new Error("network unavailable")), /network unavailable/],
      [() => "not XML", /Non-whitespace before first tag/],
    ] as const) {
      const executor = new FixtureExecutor(response);
      const updater = new TestAppUpdater("0.0.40-pi.1", executor);
      const originalSupport = updater.isUpdateSupported;
      updater.allowDowngrade = false;

      await NodeAssert.rejects(checkForUpdatesWithDulliTransition(updater), expectedError);

      NodeAssert.equal(executor.requests.length, 1);
      NodeAssert.strictEqual(updater.isUpdateSupported, originalSupport);
      NodeAssert.equal(updater.allowDowngrade, false);
    }
  });
});
