# T3 Dulli fork development

T3 Dulli is the branded distribution maintained in `YJJosh/t3code`. This repository owns its desktop and mobile identity, Pi and Workler integration, npm CLI, packaging, and release automation. Upstream publishing, T3 Connect relay deployment, and EAS/App Store submission remain disabled.

## Identity and coexistence

Build Dulli with `--brand dulli`. The default remains the upstream `t3code` brand.

| Property            | T3 Dulli value              |
| ------------------- | --------------------------- |
| Product name        | `T3 Dulli`                  |
| Application ID      | `com.yjjosh.t3dulli`        |
| Package name        | `t3-dulli`                  |
| Linux executable    | `t3-dulli-clean`            |
| Linux desktop entry | `t3-dulli-clean.desktop`    |
| Linux WM class      | `t3-dulli`                  |
| Artifact prefix     | `T3-Dulli-`                 |
| Update repository   | `YJJosh/t3code` prereleases |

A packaged build is identified from Electron's packaged application name. Dulli does not register or claim upstream's `t3code://` and `t3code-dev://` URL callbacks; it uses a separate internal renderer scheme.

Dulli defaults to isolated storage so it can be installed beside T3 Code:

- T3 home: `~/.t3-dulli` (application state lives in its `userdata` directory)
- Linux Electron user data: `${XDG_CONFIG_HOME:-~/.config}/t3-dulli`
- Windows Electron user data: `%APPDATA%/t3-dulli`
- macOS Electron user data: `~/Library/Application Support/t3-dulli`

An explicit `T3CODE_HOME`, `XDG_CONFIG_HOME`, or platform app-data override still wins. Normal home-scoped provider resources are not hidden or relocated.

## Artwork

`assets/dulli/logo.svg` is the editable source. Derived PNG and ICO files are committed so packaging is deterministic and does not require image tools on every build runner. After editing the SVG, regenerate and review the complete icon family:

```sh
scripts/dulli/generate-assets.sh
```

The desktop build stages Dulli icons for macOS, Windows, Linux, and the bundled web client. Product text is selected in source from packaged Electron metadata and the desktop build brand; do not restore recursive replacement of compiled web output.

## Building

Example unsigned Linux artifact:

```sh
./node_modules/.bin/vp run dist:desktop:artifact \
  --brand dulli \
  --platform linux \
  --target AppImage \
  --arch x64 \
  --build-version 0.0.36-pi.1
```

`T3CODE_DESKTOP_BRAND=dulli` is the environment equivalent. Dulli package metadata always defaults its updater to prereleases from `YJJosh/t3code`; `T3CODE_DESKTOP_UPDATE_REPOSITORY` remains available for an explicit test feed override.

## Linux installation

Install the newest x86_64 Dulli prerelease, or provide a tag:

```sh
scripts/dulli/install-linux-appimage.sh
scripts/dulli/install-linux-appimage.sh v0.0.36-pi.1
```

The helper downloads only a `T3-Dulli-*-x86_64.AppImage` prerelease, installs an isolated launcher and icon, and writes `t3-dulli-clean.desktop`. Future updates use the app's built-in updater. There is intentionally no restart helper that finds or kills processes by pattern.

## Releases

`.github/workflows/fork-desktop-release.yml` is the only Dulli publisher. It is manual-only and accepts the canonical `0.0.<patch>-pi.<build>` sequence. For one version it:

- runs release checks on GitHub-hosted runners;
- builds branded macOS arm64/x64, Linux x64, and Windows x64 desktop artifacts;
- signs both macOS builds with the persistent Dulli community certificate;
- builds and verifies a persistently signed `com.yjjosh.t3dulli` Android APK;
- publishes the GitHub prerelease and updater manifests; and
- publishes the same server and web client as `@yjosh/t3` through npm trusted publishing.

The workflow deliberately does not deploy a relay, invoke EAS, submit to an app store, publish the upstream `t3` package, deploy hosted web infrastructure, or mark a Dulli prerelease as GitHub's latest stable release.

Run the workflow from GitHub Actions with a version whose tag does not exist. Before announcing it, verify that the release contains `T3-Dulli-*` artifacts for every matrix target, the Android APK, macOS ZIP update payloads, blockmaps, and `latest*.yml` updater manifests. The npm job runs only after the GitHub release succeeds so an immutable npm version is never published ahead of incomplete application artifacts.

### macOS signing continuity

Dulli uses a persistent self-signed certificate rather than upstream Apple Developer credentials. The workflow requires:

- secrets `DULLI_MACOS_CERTIFICATE_P12_BASE64` and `DULLI_MACOS_CERTIFICATE_PASSWORD`; and
- repository variable `DULLI_MACOS_CERTIFICATE_SHA1`.

CI imports the key into an ephemeral non-extractable keychain, verifies its SHA-1 identity before packaging, explicitly selects it for Electron Builder, and verifies each mounted app's identifier, authority, and certificate-root requirement. It fails instead of falling back to an ad-hoc signature. Keep the original `.p12` and password in encrypted offline storage: replacing the certificate breaks built-in update continuity and requires users to reinstall manually.

The certificate is not Apple-notarized. New users must approve the app in **System Settings → Privacy & Security**. An installation from the older ad-hoc-signing era must be manually replaced once before persistent-certificate updates can install.

### Android APK signing

Android releases use `T3CODE_MOBILE_FORK_BRAND=dulli` and `T3CODE_MOBILE_FORK_VERSION=<release>`. That selects the Dulli app name and artwork, `com.yjjosh.t3dulli`, a monotonic version code, and disabled Expo OTA updates. CI produces an `assembleRelease` APK and verifies its package, version, and signer fingerprint.

The workflow requires secrets `DULLI_ANDROID_KEYSTORE_BASE64`, `DULLI_ANDROID_KEYSTORE_PASSWORD`, `DULLI_ANDROID_KEY_ALIAS`, and `DULLI_ANDROID_KEY_PASSWORD`, plus repository variable `DULLI_ANDROID_CERT_SHA256`. Keep the keystore backed up offline: Android accepts an update only when it is signed by the same key. The APK is sideloaded, not submitted with the upstream identities in `apps/mobile/eas.json`.

### npm CLI

The release publishes `apps/server` as `@yjosh/t3`, with the Dulli web brand and package repository metadata, using npm trusted publishing and GitHub OIDC. The npm trusted publisher must remain bound to repository `YJJosh/t3code` and workflow filename `fork-desktop-release.yml`; renaming that workflow requires updating npm first. Fork builds contain no relay configuration, so remote access uses pairing over the LAN, Tailscale (`--share`), or an independently managed reverse proxy.

The CLI's default state-path migration remains a separate compatibility decision. Until that is intentionally changed, use `T3CODE_HOME` or `--base-dir` when the headless Dulli server must be isolated from another T3 CLI installation.

## Installation and built-in updates

Dulli updater metadata points to prereleases in `YJJosh/t3code`, and the packaged app follows those prereleases forward on its normal **Latest** channel without enabling downgrades. Releases must therefore contain directly branded artifacts and must preserve the signing identities above.

For an update smoke test, install the previous persistently signed Dulli prerelease, publish the next prerelease from a newer commit, update through the app, and confirm the version changed while product artwork, `~/.t3-dulli`, platform-specific Electron user data, and access to the normal `~/.pi/agent` resources remain intact. Confirm an upstream T3 Code installation and its state were not changed.
