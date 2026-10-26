#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# A newly enclosing Cargo workspace can replace the active dependency lock without changing
# this package's old lockfile. Require review rather than auditing that stale file.
ancestor=$(dirname "$(pwd -P)")
while [ "$ancestor" != / ]; do
  if [ -f "$ancestor/Cargo.toml" ]; then
    echo 'Native verifier Cargo workspace changed; review the active dependency boundary' >&2
    exit 1
  fi
  ancestor=$(dirname "$ancestor")
done

# The crypto-bigint timing-advisory analysis applies to this one public-input verifier.
# New production sources, build scripts, dependency changes or accepted inputs need review.
if [ -e build.rs ] || [ -L build.rs ] || [ -n "$(find src -type l -print -quit)" ] || [ "$(find src -type f | LC_ALL=C sort)" != 'src/main.rs' ]; then
  echo 'Native verifier source inventory changed; review the public-input-only security boundary' >&2
  exit 1
fi
sha256sum --check public-input-boundary.sha256
echo 'Reviewed RUSTSEC-2026-0387 exception: this pinned public-input-only native verifier; no signing or proving use is covered.'
