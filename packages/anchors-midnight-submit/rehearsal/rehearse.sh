#!/usr/bin/env bash
# The whole preprod rehearsal in order, at the lowest CPU priority. The bundles are traced once,
# before the first anchor, and every later step reads them. Each runner phase resumes from
# evidence/raw.json; the crash drill runs one process per step so a SIGKILL is a real crash, and
# runs once: its log is evidence, so a second pass would only make the evidence gate refuse.
# Then CONSUMER=DIR ./finish.sh OUT.json verifies every anchor and composes the pack.
set -euo pipefail
cd "$(dirname "$0")"
run() { nice -n 19 node --import tsx "$@"; }
mkdir -p evidence
[ -s bundles/index.json ] || run bundles.ts 2>&1 | tee -a evidence/rehearsal.log
run run.ts chain funding deploy kind1 kind2 sameblock negatives 2>&1 | tee -a evidence/rehearsal.log
if [ -s evidence/crash.log.status ]; then
  echo "crash drill already ran: $(wc -l < evidence/crash.log.status) steps in evidence/crash.log.status"
else
  for step in "kill-before crash-before-broadcast" "recover crash-before-broadcast" "kill-after crash-after-broadcast" "recover crash-after-broadcast"; do
    set +e
    run crash.ts $step 2>>evidence/crash.err | grep '^{' >> evidence/crash.log
    echo "crash.ts $step exit=${PIPESTATUS[0]}" >> evidence/crash.log.status
    set -e
  done
fi
run run.ts rotation 2>&1 | tee -a evidence/rehearsal.log
run docs.ts 2>&1 | tee -a evidence/rehearsal.log
echo done
