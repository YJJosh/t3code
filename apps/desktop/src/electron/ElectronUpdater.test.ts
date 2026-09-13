import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    currentVersion: { version: "0.0.40-pi.1" },
    isUpdateSupported: vi.fn((_updateInfo: { version: string }) => true),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.currentVersion = { version: "0.0.40-pi.1" };
    autoUpdaterMock.isUpdateSupported = vi.fn((_updateInfo: { version: string }) => true);
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater
        .checkForUpdates({ allowDulliTransition: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("allows only a forward same-base Pi-to-Dulli build transition", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      let allowDowngradeDuringSupportCheck = false;
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
        const supported = await autoUpdaterMock.isUpdateSupported({
          version: "0.0.40-dulli.2",
        });
        allowDowngradeDuringSupportCheck = autoUpdaterMock.allowDowngrade;
        assert.isTrue(supported);
        return null;
      });

      yield* updater.checkForUpdates({ allowDulliTransition: true });

      assert.isTrue(allowDowngradeDuringSupportCheck);
      assert.isFalse(autoUpdaterMock.allowDowngrade);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("does not enable downgrade for unrelated older candidates", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      for (const version of [
        "0.0.40-dulli.1",
        "0.0.39-dulli.99",
        "0.0.40-other.2",
        "0.0.40-dulli.02",
        "1.2.3-dulli.2",
      ]) {
        autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
          await autoUpdaterMock.isUpdateSupported({ version });
          assert.isFalse(autoUpdaterMock.allowDowngrade, version);
          return null;
        });
        yield* updater.checkForUpdates({ allowDulliTransition: true });
      }
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves support rejection and restores updater hooks after failure", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const originalSupport = vi.fn((_updateInfo: { version: string }) => false);
      autoUpdaterMock.isUpdateSupported = originalSupport;
      const cause = new Error("feed failed after support check");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
        const supported = await autoUpdaterMock.isUpdateSupported({
          version: "0.0.40-dulli.2",
        });
        assert.isFalse(supported);
        assert.isFalse(autoUpdaterMock.allowDowngrade);
        throw cause;
      });

      const error = yield* updater
        .checkForUpdates({ allowDulliTransition: true })
        .pipe(Effect.flip);

      assert.strictEqual(error.cause, cause);
      assert.strictEqual(autoUpdaterMock.isUpdateSupported, originalSupport);
      assert.isFalse(autoUpdaterMock.allowDowngrade);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("cleans up after synchronous updater throws and permits retry", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const originalSupport = autoUpdaterMock.isUpdateSupported;
      const cause = new Error("synchronous updater failure");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => {
        throw cause;
      });

      const error = yield* updater
        .checkForUpdates({ allowDulliTransition: true })
        .pipe(Effect.flip);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(autoUpdaterMock.isUpdateSupported, originalSupport);
      assert.isFalse(autoUpdaterMock.allowDowngrade);

      yield* updater.checkForUpdates({ allowDulliTransition: true });
      assert.equal(autoUpdaterMock.checkForUpdates.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
