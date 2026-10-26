import { authorKey, verifyMidnightAnchor } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { authorKey as trackedAuthorKey, verifyMidnightAnchor as trackedVerifier } from "../../anchors-midnight/src/index.js";

// The rehearsal tsconfig maps every submitter import of the public SDK to tracked source.
// Fail before opening wallets/keys when invoked with another tsconfig or an ignored stale dist.
export function assertSourceRuntime(): void {
  if (authorKey !== trackedAuthorKey || verifyMidnightAnchor !== trackedVerifier) throw new Error("Rehearsal must load the tracked verifier source; use this directory's tsconfig (TSX_TSCONFIG_PATH)");
}
