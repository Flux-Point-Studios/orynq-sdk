#!/usr/bin/env bash
# Installs compactc 0.31.1 into DEST and the ZK public parameters the registry circuits need
# (k=13 and k=14) into PARAMS_DIR, refusing any file whose sha256 differs from compactc.sha256
# beside this script. The zip pins are the digests GitHub publishes for the release assets;
# the params pins are the ones midnight-ledger 8.1.3 compiles into its data provider.
#   tools/compactc/install.sh DEST [PARAMS_DIR]
# PARAMS_DIR defaults to $MIDNIGHT_PP, then ~/.cache/midnight/zk-params, where zkir looks.
set -euo pipefail

version=0.31.1
here=$(cd "$(dirname "$0")" && pwd)
release=${COMPACTC_RELEASE_URL:-https://github.com/midnightntwrk/compact/releases/download/compactc-v$version}
param_source=${MIDNIGHT_PARAM_SOURCE:-https://srs.midnight.network}
dest=${1:?usage: install.sh DEST [PARAMS_DIR]}
params=${2:-${MIDNIGHT_PP:-$HOME/.cache/midnight/zk-params}}

die() { echo "compactc install: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
pin() {
  local want
  want=$(awk -v f="$1" '$2 == f { print $1 }' "$here/compactc.sha256")
  [ -n "$want" ] || die "no pin for $1"
  echo "$want"
}
matches() { [ -f "$1" ] && [ "$(sha256 "$1")" = "$(pin "$2")" ]; }
verify() { matches "$1" "$2" || die "sha256 mismatch for $2: got $(sha256 "$1"), pinned $(pin "$2")"; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=x86_64-unknown-linux-musl ;;
  Linux-aarch64 | Linux-arm64) platform=aarch64-unknown-linux-musl ;;
  Darwin-x86_64) platform=x86_64-darwin ;;
  Darwin-arm64 | Darwin-aarch64) platform=aarch64-darwin ;;
  *) die "no compactc $version build for $(uname -s) $(uname -m)" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! { matches "$dest/compactc.bin" "$platform/compactc.bin" && matches "$dest/zkir" "$platform/zkir" && [ -x "$dest/compactc" ]; }; then
  zip=compactc_v${version}_$platform.zip
  curl -sSfL -o "$work/$zip" "$release/$zip"
  verify "$work/$zip" "$zip"
  mkdir "$work/release"
  unzip -q "$work/$zip" -d "$work/release"
  verify "$work/release/compactc.bin" "$platform/compactc.bin"
  verify "$work/release/zkir" "$platform/zkir"
  mkdir -p "$dest"
  for f in "$work/release"/*; do
    rm -f "$dest/$(basename "$f")"
    cp "$f" "$dest/"
  done
fi
reported=$("$dest/compactc" --version)
[ "$reported" = "$version" ] || die "compactc reports $reported, expected $version"

mkdir -p "$params"
for k in 13 14; do
  name=bls_midnight_2p$k
  matches "$params/$name" "$name" && continue
  curl -sSfL -o "$work/$name" "$param_source/$name"
  verify "$work/$name" "$name"
  mv "$work/$name" "$params/$name"
done

echo "compactc $version ($platform) verified in $dest; bls_midnight_2p13 and 2p14 verified in $params"
