---
"@fluxpointstudios/orynq-sdk-recorder-openclaw": patch
"@fluxpointstudios/orynq-openclaw": patch
---

The recorder daemon no longer dies when a session file changes under it.

A session file deleted between discovery and the read (OpenClaw removes one when a session resets) is dropped from tail state instead of throwing. Any other unreadable file is skipped for that pass and keeps its offset. A scan or anchor pass that fails outright is logged and the loop continues, where before the throw ended `runForever` and relied on the service manager to restart it.

`@fluxpointstudios/orynq-openclaw` is bumped so installs that run `@latest` through npx pick up the fixed recorder.
