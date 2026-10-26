---
"@fluxpointstudios/orynq-sdk-quickstart": patch
---

`orynq verify midnight --author <key>` prints the key that wrote the anchor: `expected` when it is the key you gave, and `mismatch`, naming both keys, when another key wrote it. A mismatch is `invalid`, so it no longer reads like an anchor by the key you gave when finality is not shown.
