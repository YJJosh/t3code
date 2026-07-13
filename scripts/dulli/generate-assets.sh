#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
asset_dir="$repo_root/assets/dulli"
source_svg="$asset_dir/logo.svg"

if command -v magick >/dev/null 2>&1; then
  imagemagick=(magick)
elif command -v convert >/dev/null 2>&1; then
  imagemagick=(convert)
else
  echo "ImageMagick ('magick' or 'convert') is required." >&2
  exit 1
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

render() {
  local size="$1"
  local output="$2"
  "${imagemagick[@]}" -background none "$source_svg" -resize "${size}x${size}" -depth 8 "PNG32:$output"
}

render 1024 "$asset_dir/dulli-universal-1024.png"

# macOS 26 puts legacy edge-to-edge ICNS artwork on a light compatibility tile.
# Keep the artwork inside Apple's icon grid and use the platform squircle so the
# bundled icon remains black when the app is not running.
macos_tmp="$tmp_root/macos"
mkdir -p "$macos_tmp"
render 824 "$macos_tmp/dulli.png"
"${imagemagick[@]}" \
  "$macos_tmp/dulli.png" \
  \( -size 824x824 xc:none -fill white -draw "roundrectangle 0,0 823,823 180,180" \) \
  -alpha set \
  -compose DstIn \
  -composite \
  -background none \
  -gravity center \
  -extent 1024x1024 \
  -depth 8 \
  "PNG32:$asset_dir/dulli-macos-1024.png"

render 180 "$asset_dir/dulli-web-apple-touch-180.png"
render 32 "$asset_dir/dulli-web-favicon-32x32.png"
render 16 "$asset_dir/dulli-web-favicon-16x16.png"

windows_tmp="$tmp_root/windows"
mkdir -p "$windows_tmp"
for size in 16 24 32 48 64 128 256; do
  render "$size" "$windows_tmp/$size.png"
done
"${imagemagick[@]}" \
  "$windows_tmp/16.png" \
  "$windows_tmp/24.png" \
  "$windows_tmp/32.png" \
  "$windows_tmp/48.png" \
  "$windows_tmp/64.png" \
  "$windows_tmp/128.png" \
  "$windows_tmp/256.png" \
  "$asset_dir/dulli-windows.ico"
cp "$asset_dir/dulli-windows.ico" "$asset_dir/dulli-web-favicon.ico"

echo "Regenerated T3 Dulli assets in $asset_dir"
