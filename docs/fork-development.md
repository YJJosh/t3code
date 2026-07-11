# T3 Dulli fork development

T3 Dulli is the branded desktop distribution maintained in `YJJosh/t3code`. This repository is the source of truth for its application changes, `:D` artwork, package identity, and release workflow. Pi extensions and profiles remain in `pi-config`; the Workler library remains in its own repository.

## Working on the fork

1. Fetch `origin` and start from `origin/main` in an isolated Workler clone or Git worktree.
2. Keep branch names descriptive and submit changes through a pull request.
3. Do not commit `.workler`, credentials, downloaded release artifacts, machine-local paths, `.t3-dulli` state, or generated logs.
4. Before opening a pull request, run:

   ```sh
   ./node_modules/.bin/vp check
   ./node_modules/.bin/vp run typecheck
   ./node_modules/.bin/vp test <relevant-test-files>
   ```

   Run `./node_modules/.bin/vp run lint:mobile` when native mobile code changes.

Existing Git worktrees are supported and must not be converted automatically. New Workler clones use `<repository>/.worktrees/<safe-name>` while preserving the requested Git branch name.

## Branding and identity

The build command accepts `--brand t3code|dulli`, with `t3code` as the default. Dulli releases use:

| Property            | Value                       |
| ------------------- | --------------------------- |
| Product name        | `T3 Dulli`                  |
| Application ID      | `com.yjjosh.t3dulli`        |
| Package name        | `t3-dulli`                  |
| Linux executable    | `t3-dulli-clean`            |
| Linux desktop entry | `t3-dulli-clean.desktop`    |
| Linux WM class      | `t3-dulli`                  |
| Artifact prefix     | `T3-Dulli-`                 |
| Update repository   | `YJJosh/t3code` prereleases |

A packaged Dulli build is detected from Electron's packaged application name. It defaults to isolated state and user-data paths:

- application state: `~/.t3-dulli`
- Linux Electron user data: `${XDG_CONFIG_HOME:-~/.config}/t3-dulli`
- Windows Electron user data: `%APPDATA%/t3-dulli`
- macOS Electron user data: `~/Library/Application Support/t3-dulli`

These paths do not hide normal home-scoped Pi resources, including `~/.pi/agent`. Explicit `T3CODE_HOME`, `XDG_CONFIG_HOME`, and platform app-data overrides remain supported.

### Artwork

Canonical artwork lives in `assets/dulli/`. `logo.svg` is the editable source; committed PNG and ICO files make builds deterministic and avoid requiring image tools on every runner. After changing the SVG, regenerate derived files with ImageMagick and review all changes:

```sh
scripts/dulli/generate-assets.sh
```

The desktop build stages Dulli artwork for macOS, Windows, Linux, and the bundled web client. It also applies Dulli product text before Electron Builder packages the app. Do not restore the retired post-build AppImage patching flow: release artifacts must be branded at build time so updates cannot replace Dulli with generic T3 Code.

## Building locally

Example unsigned Linux build:

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=YJJosh/t3code \
  ./node_modules/.bin/vp run dist:desktop:artifact \
  --brand dulli \
  --platform linux \
  --target AppImage \
  --arch x64 \
  --build-version 0.0.29-pi.4
```

Use the equivalent `mac/dmg` or `win/nsis` target on those host platforms. Fork release builds are intentionally unsigned until signing infrastructure is configured.

## Releases

`.github/workflows/fork-desktop-release.yml` is the Dulli-only release workflow. It:

- accepts a prerelease version such as `0.0.29-pi.4`;
- runs on GitHub-hosted `ubuntu-24.04`, `windows-2025`, and `macos-14` runners;
- builds all targets with `--brand dulli`;
- publishes installers, blockmaps, and updater manifests to a GitHub prerelease;
- creates the tag only after preflight and builds succeed.

Run it from GitHub Actions with a version that does not already have a tag. Verify that the release contains `T3-Dulli-*` installers for every platform, `latest*.yml` updater manifests, macOS ZIP update payloads, and blockmaps before announcing it.

The upstream `.github/workflows/release.yml` workflow has no scheduled trigger in this fork. Do not restore its nightly cron: Dulli releases are created manually through **Fork Desktop Release** and the upstream workflow requires production infrastructure that is not configured here.

Do not use Blacksmith/self-hosted labels, public `t3-api` naming, embedded fork credentials, or hardcoded checkout paths in workflows and scripts.

## Installation and built-in updates

Linux users can bootstrap an x86_64 AppImage from a checkout:

```sh
scripts/dulli/install-linux-appimage.sh                 # newest Dulli prerelease
scripts/dulli/install-linux-appimage.sh v0.0.29-pi.4    # explicit release
```

The installer creates `~/.local/bin/t3-dulli`, `t3-dulli-clean.desktop`, and a uniquely keyed icon. `scripts/dulli/restart-linux.sh` restarts that installation during local smoke testing.

After bootstrap, use the update control in T3 Dulli. Dulli's packaged update configuration points to `YJJosh/t3code`, permits prerelease discovery on its normal `latest` UI channel, and does not enable downgrade behavior. Releases must therefore contain directly branded artifacts; publishing generic artifacts under Dulli manifests would undo the product identity during an update.

For an update smoke test:

1. Install the previous Dulli prerelease and launch it.
2. Publish the next prerelease from a newer commit.
3. Check for updates in Dulli, download it, and restart through the app.
4. Confirm the version changed and the following remain intact:
   - `:D` icons and `T3 Dulli` product text;
   - `t3-dulli-clean.desktop` and the dock/taskbar identity;
   - `~/.t3-dulli` and platform-specific `t3-dulli` user data;
   - access to `~/.pi/agent` profiles, extensions, and skills.
5. Confirm an upstream T3 Code installation and its state were not changed.

Personal shell updaters (including an `up` alias) are not part of the product and should not be documented as the distributed update mechanism.
