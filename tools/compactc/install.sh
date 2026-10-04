#!/usr/bin/env bash
# Installs compactc 0.31.1 into DEST and the ZK public parameters the registry circuits need
# (k=13 and k=14) into PARAMS_DIR, refusing any file whose sha256 differs from compactc.sha256
# beside this script. The zip pins are the digests GitHub publishes for the release assets,
# and every file inside each zip is pinned as well; the params pins are the ones
# midnight-ledger 8.1.3 compiles into its data provider.
# An existing install counts only if no one but the caller could have changed it: both
# directories must be real directories the caller owns that group and others cannot write,
# and each installed file a regular file under the same rule whose digest matches its pin.
# Every directory above them must be a real directory owned by the caller or root that group
# and others cannot write, since whoever can write a directory can rename what lies below it.
# A root-owned sticky directory such as /tmp only stops others deleting what they do not own,
# so nothing is installed below one.
#   tools/compactc/install.sh DEST [PARAMS_DIR]
# PARAMS_DIR defaults to $MIDNIGHT_PP, then ~/.cache/midnight/zk-params, where zkir looks.
set -euo pipefail
umask 022

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
others_can_write() { [ -n "$(find "$1" -maxdepth 0 \( -perm -g+w -o -perm -o+w \) -print)" ]; }
safe_ancestors() {
  local dir
  case /$1/ in */./* | */../*) die "$1 has a . or .. component; pass the directory itself" ;; esac
  case $1 in /*) dir=$1 ;; *) dir=$PWD/$1 ;; esac
  while [ "$dir" != / ]; do
    dir=$(dirname "$dir")
    [ -e "$dir" ] || [ -L "$dir" ] || continue
    [ ! -L "$dir" ] || die "$dir, above $1, is a symlink; pass a path with no symlink in it"
    [ -n "$(find "$dir" -maxdepth 0 \( -uid 0 -o -uid "$(id -u)" \) -print)" ] ||
      die "$dir, above $1, is owned by another account, which could replace what is installed below it"
    [ -z "$(find "$dir" -maxdepth 0 -uid 0 -perm -1000 -perm -o+w -print)" ] ||
      die "$dir, above $1, is a shared sticky directory; install below a directory only you can write, such as ~/.cache/midnight"
    ! others_can_write "$dir" || die "$dir, above $1, is writable by group or others, who could replace what is installed below it"
  done
}
private_dir() {
  safe_ancestors "$1"
  [ ! -L "$1" ] || die "$1 is a symlink; pass the directory it points to"
  mkdir -p "$1"
  [ -O "$1" ] || die "$1 is not owned by $(id -un)"
  ! others_can_write "$1" || die "$1 is writable by group or others (chmod go-w it, or choose a directory only you can write)"
}
installed() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && ! others_can_write "$1" && [ "$(sha256 "$1")" = "$(pin "$2")" ]; }
verify() { [ "$(sha256 "$1")" = "$(pin "$2")" ] || die "sha256 mismatch for $2: got $(sha256 "$1"), pinned $(pin "$2")"; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=x86_64-unknown-linux-musl ;;
  Linux-aarch64 | Linux-arm64) platform=aarch64-unknown-linux-musl ;;
  Darwin-x86_64) platform=x86_64-darwin ;;
  Darwin-arm64 | Darwin-aarch64) platform=aarch64-darwin ;;
  *) die "no compactc $version build for $(uname -s) $(uname -m)" ;;
esac

files=$(awk -v p="$platform/" 'index($2, p) == 1 { print substr($2, length(p) + 1) }' "$here/compactc.sha256")
[ -n "$files" ] || die "no file pins for $platform"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

private_dir "$dest"
private_dir "$params"

intact=1
for f in $files; do installed "$dest/$f" "$platform/$f" || intact=0; done
if [ "$intact" = 0 ]; then
  zip=compactc_v${version}_$platform.zip
  curl -sSfL -o "$work/$zip" "$release/$zip"
  verify "$work/$zip" "$zip"
  mkdir "$work/release"
  unzip -q "$work/$zip" -d "$work/release"
  for f in $files; do verify "$work/release/$f" "$platform/$f"; done
  for f in $files; do
    rm -f "$dest/$f"
    cp "$work/release/$f" "$dest/$f"
    chmod 0555 "$dest/$f"
  done
fi
reported=$("$dest/compactc" --version)
[ "$reported" = "$version" ] || die "compactc reports $reported, expected $version"

for k in 13 14; do
  name=bls_midnight_2p$k
  installed "$params/$name" "$name" && continue
  curl -sSfL -o "$work/$name" "$param_source/$name"
  verify "$work/$name" "$name"
  chmod 0444 "$work/$name"
  rm -f "$params/$name"
  mv "$work/$name" "$params/$name"
done

echo "compactc $version ($platform) verified in $dest; bls_midnight_2p13 and 2p14 verified in $params"
