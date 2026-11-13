#!/usr/bin/env node
// A frontend that says READY, then sends a message of an unknown kind, and stays up until it is
// killed or ten seconds pass. The unknown kind follows READY in a later write: two writes in one
// tick can reach the host as a single chunk, which it refuses whole, before it has seen READY.
process.stdout.write(Uint8Array.of(0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0));
setTimeout(() => process.stdout.write(Uint8Array.of(0, 0, 0, 9, 7)), 100);
setTimeout(() => process.exit(0), 10_000);
