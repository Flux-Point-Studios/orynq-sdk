#!/usr/bin/env bash
# After rehearse.sh: verifies every recorded anchor from CONSUMER, a directory outside the
# repository into which only the packed verify package was installed (README.md), then composes
# the evidence pack. Each step exits non-zero, and no pack is written, on any claim it cannot
# establish; evidence/verified.json keeps the verifier's gate.
#   CONSUMER=DIR ./finish.sh OUT.json
set -euo pipefail
cd "$(dirname "$0")"
out=$(realpath -m "$1")
C=${CONSUMER:?set CONSUMER to the directory that installed only the packed verify package}
rm -rf "$C/evidence"
mkdir -p "$C/evidence"
cp gate.mjs verify-all.mjs "$C/"
cp evidence/raw.json evidence/crash.log evidence/crash.log.status "$C/evidence/"
cp bundles/index.json "$C/evidence/bundles.json"
cp -r evidence/known-authors "$C/evidence/"
set +e
(cd "$C" && nice -n 19 node verify-all.mjs evidence "$HOME/.secrets/blockfrost-midnight-preprod.project_id" > evidence/verified.json)
verified=$?
set -e
cp "$C/evidence/verified.json" evidence/verified.json
if [ "$verified" -ne 0 ]; then echo "verify-all exited $verified: see the GATE lines above and evidence/verified.json" >&2; exit "$verified"; fi
nice -n 19 node --import tsx compose.ts . "$out"
