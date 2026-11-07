import { homedir } from "node:os";
import { proofReleaseJournal } from "./proof-release.js";

// Where the mainnet scripts keep their journals, results and wallet state: deploy-mainnet journals
// the deploy at DEPLOY_JOURNAL, where anchor-mainnet reads which registry FPS deployed, and
// anchor-mainnet its anchors at ANCHORS_JOURNAL. The standing service keeps its own under
// STANDING_STATE_ROOT (runner/STANDING.md).
export const STATE = `${homedir()}/.local/state/orynq-midnight`;
export const DEPLOY_JOURNAL = `${STATE}/mainnet-deploy.sqlite`;
export const ANCHORS_JOURNAL = `${STATE}/mainnet-anchors.sqlite`;
export const STANDING_STATE_ROOT = `${STATE}/standing`;

// Every journal a fee of the shared mainnet wallet is recorded in. The mainnet scripts and the
// standing service open that one wallet and its one state file, and each opens it with all of
// them, since a wallet-sdk 1.x state file is moved aside only while none holds its fee in flight.
export const MAINNET_WALLET_JOURNALS: readonly string[] = [DEPLOY_JOURNAL, ANCHORS_JOURNAL, proofReleaseJournal(`${STATE}/runner`), `${STANDING_STATE_ROOT}/attempts.sqlite`];
