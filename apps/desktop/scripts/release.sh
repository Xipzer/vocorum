#!/usr/bin/env bash
# Builds Vocorum app installers the same way every time, so anyone can rebuild a
# release from its git tag and compare checksums.
#
#   apps/desktop/scripts/release.sh linux|windows|macos [out-dir]
#
# linux and windows run on Linux (windows is cross-built with cargo-xwin, clang,
# lld and NSIS); macos runs on a Mac with Xcode. Every run writes the installers,
# their updater signatures when a key is given, and SHA256SUMS to out-dir.
#
# Optional environment:
#   VOCORUM_UPDATER_PUBKEY            publisher key the app trusts for updates (without it the app never updates)
#   TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]  matching private key: makes the .sig files for the hub's update feed
#   APPLE_SIGNING_IDENTITY            macOS code signing identity (with APPLE_API_* for notarisation)
#
# What keeps builds repeatable: the Rust version in rust-toolchain.toml, Cargo.lock
# and pnpm-lock.yaml (--locked / --frozen-lockfile), SOURCE_DATE_EPOCH from the
# commit, and build paths remapped out of the binary.
set -euo pipefail

os=${1:?usage: release.sh linux|windows|macos [out-dir]}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
app=$repo/apps/desktop/src-tauri
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$app/Cargo.toml" | head -1)
out=${2:-$repo/apps/desktop/release/$version}
mkdir -p "$out"

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$repo" log -1 --format=%ct)}
export CARGO_INCREMENTAL=0
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$repo=/build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$HOME=/home"

config=$(python3 - <<'EOF'
import json, os
c = {}
pub = os.environ.get("VOCORUM_UPDATER_PUBKEY", "")
if pub:
    c["plugins"] = {"updater": {"pubkey": pub, "requireSignedVersion": True}}
    if os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
        c["bundle"] = {"createUpdaterArtifacts": True}
print(json.dumps(c))
EOF
)

pnpm=${PNPM:-pnpm}
(cd "$repo" && $pnpm install --frozen-lockfile >/dev/null && $pnpm build:app-web >/dev/null)

case $os in
  linux)
    (cd "$app" && cargo tauri build --bundles deb,appimage --config "$config" -- --locked)
    cp "$app"/target/release/bundle/deb/*_"$version"_*.deb* "$out"/
    cp "$app"/target/release/bundle/appimage/*_"$version"_*.AppImage* "$out"/
    ;;
  windows)
    (cd "$app" && XWIN_ACCEPT_LICENSE=1 cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --config "$config" -- --locked)
    cp "$app"/target/x86_64-pc-windows-msvc/release/bundle/nsis/*_"$version"_*-setup.exe* "$out"/
    ;;
  macos)
    (cd "$app" && cargo tauri build --bundles app,dmg --config "$config" -- --locked)
    bundle=$app/target/release/bundle
    arch=$(uname -m | sed 's/arm64/aarch64/')
    cp "$bundle"/dmg/*_"$version"_*.dmg "$out"/
    if [ -f "$bundle/macos/Vocorum.app.tar.gz" ]; then
      cp "$bundle/macos/Vocorum.app.tar.gz" "$out/Vocorum_${version}_${arch}.app.tar.gz"
      cp "$bundle/macos/Vocorum.app.tar.gz.sig" "$out/Vocorum_${version}_${arch}.app.tar.gz.sig"
    fi
    ;;
  *) echo "unknown system: $os" >&2; exit 2 ;;
esac

cd "$out"
sum() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sum $(ls | grep -v -e '^SHA256SUMS$' -e '\.sig$' -e '^release.json$' | sort) > SHA256SUMS
cat SHA256SUMS
