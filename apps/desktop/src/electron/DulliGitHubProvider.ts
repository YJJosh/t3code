import * as Predicate from "effect/Predicate";

import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";

const DULLI_CHANNEL = "dulli";
const NO_PUBLISHED_VERSIONS_ERROR = "ERR_UPDATER_NO_PUBLISHED_VERSIONS";

type CustomPublishOptions = Extract<
  Exclude<Parameters<AppUpdater["setFeedURL"]>[0], string>,
  { readonly provider: "custom" }
>;
type ProviderRuntimeOptions = ConstructorParameters<typeof GitHubProvider>[2];

/**
 * GitHubProvider derives custom prerelease channels from the installed version.
 * A Pi install therefore cannot discover the first Dulli tag without checking
 * the Dulli channel explicitly. Once installed, Dulli follows its own channel
 * through the upstream provider as usual.
 */
export class DulliGitHubProvider extends GitHubProvider {
  readonly #dulliProvider: GitHubProvider;
  readonly #updater: AppUpdater;

  constructor(
    options: CustomPublishOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    const githubOptions = { ...options, provider: "github" as const };
    super(githubOptions, updater, runtimeOptions);
    this.#updater = updater;
    const dulliUpdater = new Proxy(updater, {
      get: (target, property, receiver) => {
        if (property === "channel") return DULLI_CHANNEL;
        // The migration candidate sorts below Pi in semver, so upstream's full
        // changelog filter would omit it. Keep the selected release's own notes.
        if (property === "fullChangelog") return false;
        return Reflect.get(target, property, receiver);
      },
    });
    this.#dulliProvider = new GitHubProvider(githubOptions, dulliUpdater, runtimeOptions);
  }

  override setRequestHeaders(value: Parameters<GitHubProvider["setRequestHeaders"]>[0]): void {
    super.setRequestHeaders(value);
    this.#dulliProvider.setRequestHeaders(value);
  }

  override async getLatestVersion() {
    if (this.#updater.channel !== null || this.#updater.currentVersion.prerelease[0] !== "pi") {
      return await super.getLatestVersion();
    }

    try {
      return await this.#dulliProvider.getLatestVersion();
    } catch (cause) {
      // Only absence of a matching Dulli tag falls back to Pi. Network,
      // malformed-feed, and missing-manifest failures retain upstream behavior.
      if (!Predicate.hasProperty(cause, "code") || cause.code !== NO_PUBLISHED_VERSIONS_ERROR) {
        throw cause;
      }
      return await super.getLatestVersion();
    }
  }
}
