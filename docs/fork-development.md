# T3 Dulli fork development

T3 Dulli is the branded desktop distribution maintained in `YJJosh/t3code`. This repository is the source of truth for its application changes, `:D` artwork, package identity, and release workflow. Pi extensions and profiles remain in `pi-config`; the Workler library remains in its own repository.

## Working on the fork

1. Fetch `origin` and start from `origin/main` in an isolated Workler clone or Git worktree.
2. Keep branch names descriptive and submit changes through a pull request.
3. Do not commit credentials, downloaded release artifacts, machine-local paths, `.t3-dulli` state, or generated logs.
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

Use the equivalent `mac/dmg` or `win/nsis` target on those host platforms. Local macOS builds use an ad-hoc signature by default. The fork release workflow instead requires the persistent community signing identity described below.

## Persistent macOS community signing

T3 Dulli uses one long-lived self-signed certificate so every macOS release has the same Squirrel.Mac designated requirement. This enables built-in updates without an Apple Developer subscription. It does **not** provide Apple trust or notarization: users still approve the app with **System Settings → Privacy & Security → Open Anyway** on first install, and they do not need to install or trust the certificate themselves.

Generate the certificate once on a trusted Mac, outside the repository. Do not repeat this for each release:

```sh
umask 077
SIGNING_DIR="$HOME/.local/share/t3-dulli-signing"
mkdir -p "$SIGNING_DIR"

cat > "$SIGNING_DIR/openssl.cnf" <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = code_signing
prompt = no

[ dn ]
CN = T3 Dulli Community Code Signing
O = YJJosh
OU = T3 Dulli Community Releases

[ code_signing ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

openssl req \
  -new \
  -newkey rsa:3072 \
  -x509 \
  -sha256 \
  -days 3650 \
  -nodes \
  -config "$SIGNING_DIR/openssl.cnf" \
  -keyout "$SIGNING_DIR/t3-dulli-community-signing.key" \
  -out "$SIGNING_DIR/t3-dulli-community-signing.crt"

P12_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
export P12_PASSWORD
printf '%s\n' "$P12_PASSWORD" > "$SIGNING_DIR/t3-dulli-community-signing.password"
openssl pkcs12 \
  -export \
  -name "T3 Dulli Community Code Signing" \
  -inkey "$SIGNING_DIR/t3-dulli-community-signing.key" \
  -in "$SIGNING_DIR/t3-dulli-community-signing.crt" \
  -out "$SIGNING_DIR/t3-dulli-community-signing.p12" \
  -passout env:P12_PASSWORD
```

Store the base64-encoded PKCS#12 file and its password as two GitHub Actions repository secrets. Pin the certificate's public SHA-1 identity in a repository variable so an accidental secret replacement cannot silently break update continuity:

```sh
SIGNING_DIR="${SIGNING_DIR:-$HOME/.local/share/t3-dulli-signing}"
P12_PASSWORD="$(tr -d '\n' < "$SIGNING_DIR/t3-dulli-community-signing.password")"
CERTIFICATE_SHA1="$(
  openssl x509 \
    -in "$SIGNING_DIR/t3-dulli-community-signing.crt" \
    -noout -fingerprint -sha1 |
    awk -F= '{ gsub(":", "", $2); print toupper($2) }'
)"
base64 < "$SIGNING_DIR/t3-dulli-community-signing.p12" |
  gh secret set DULLI_MACOS_CERTIFICATE_P12_BASE64 --repo YJJosh/t3code
printf '%s' "$P12_PASSWORD" |
  gh secret set DULLI_MACOS_CERTIFICATE_PASSWORD --repo YJJosh/t3code
gh variable set DULLI_MACOS_CERTIFICATE_SHA1 \
  --repo YJJosh/t3code \
  --body "$CERTIFICATE_SHA1"
unset P12_PASSWORD CERTIFICATE_SHA1
```

The same values can instead be entered under **Repository Settings → Secrets and variables → Actions**. The first secret's value is the base64 text, not the binary `.p12` file; `DULLI_MACOS_CERTIFICATE_SHA1` is a non-secret Actions variable.

Keep an encrypted offline backup of the `.p12` file and put its password in a password manager. Then remove the unencrypted `.key` and `.password` files. Losing or replacing the certificate changes the designated requirement and forces another manual migration for every installed copy. Inspect the public certificate without exposing its key:

```sh
openssl x509 \
  -in "$SIGNING_DIR/t3-dulli-community-signing.crt" \
  -noout -subject -dates -fingerprint -sha256
```

The workflow imports the certificate as a non-extractable key into an ephemeral keychain, checks it against the pinned SHA-1 repository variable, and temporarily trusts only the public certificate in the disposable GitHub-hosted runner's admin trust domain. It explicitly selects the identity for Electron Builder, verifies the resulting bundle's certificate-root requirement, and removes the private-key keychain before uploading artifacts; the public trust entry disappears with the runner VM. It fails rather than silently falling back to ad-hoc signing when any signing configuration is missing or mismatched.

Existing ad-hoc releases cannot accept the first self-signed release because their designated requirements are already tied to release-specific hashes. Install the first self-signed release manually once; subsequent releases signed with the unchanged certificate can update through the app.

## Releases

`.github/workflows/fork-desktop-release.yml` is the Dulli-only release workflow. It:

- accepts a prerelease version such as `0.0.29-pi.4`;
- runs on GitHub-hosted `ubuntu-24.04`, `windows-2025`, and `macos-14` runners;
- builds all targets with `--brand dulli`;
- imports the persistent community certificate for both macOS architectures;
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

After bootstrap, use the update control in T3 Dulli. Dulli's packaged update configuration points to `YJJosh/t3code`, permits prerelease discovery on its normal `latest` UI channel, and does not enable downgrade behavior. macOS updates additionally require every release to use the same persistent community certificate. Releases must therefore contain directly branded artifacts; publishing generic artifacts under Dulli manifests would undo the product identity during an update.

For an update smoke test, use two releases that already share the persistent certificate. The initial ad-hoc-to-self-signed migration must be tested as a manual replacement instead.

1. Install the previous self-signed Dulli prerelease and launch it.
2. Publish the next self-signed prerelease from a newer commit.
3. Check for updates in Dulli, download it, and restart through the app.
4. Confirm the version changed and the following remain intact:
   - `:D` icons and `T3 Dulli` product text;
   - `t3-dulli-clean.desktop` and the dock/taskbar identity;
   - `~/.t3-dulli` and platform-specific `t3-dulli` user data;
   - access to `~/.pi/agent` profiles, extensions, and skills.
5. Confirm an upstream T3 Code installation and its state were not changed.

Personal shell updaters (including an `up` alias) are not part of the product and should not be documented as the distributed update mechanism.
