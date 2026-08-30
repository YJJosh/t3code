# T3 Dulli desktop development

T3 Dulli is the branded desktop distribution maintained in `YJJosh/t3code`. This slice covers desktop identity, assets, packaging, local installation, and updater routing. Mobile, the npm CLI, Pi, Workler, relay infrastructure, and release automation are separate concerns.

## Identity and coexistence

Build Dulli with `--brand dulli`. The default remains the upstream `t3code` brand.

| Property | T3 Dulli value |
| --- | --- |
| Product name | `T3 Dulli` |
| Application ID | `com.yjjosh.t3dulli` |
| Package name | `t3-dulli` |
| Linux executable | `t3-dulli-clean` |
| Linux desktop entry | `t3-dulli-clean.desktop` |
| Linux WM class | `t3-dulli` |
| Artifact prefix | `T3-Dulli-` |
| Update repository | `YJJosh/t3code` prereleases |

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

## Release gaps

The branded build path emits updater metadata and accepts Dulli prereleases on the normal in-app latest channel. Fork release workflows, persistent macOS community-signing setup, Windows signing, and release publication are handled in later release slices; do not publish ad-hoc artifacts as an update to an installed persistently signed build.
