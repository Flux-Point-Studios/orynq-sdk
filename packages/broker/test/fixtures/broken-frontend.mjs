#!/usr/bin/env node
// A frontend that says READY, then sends a message of an unknown kind, and stays up until it is
// killed or ten seconds pass.
process.stdout.write(Uint8Array.of(0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0));
process.stdout.write(Uint8Array.of(0, 0, 0, 9, 7));
setTimeout(() => process.exit(0), 10_000);
