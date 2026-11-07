import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthorKeyFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MAINNET_WALLET_JOURNALS } from "../src/mainnet-state.js";
import { proofReleaseJournal } from "../src/proof-release.js";
import { mainnetPaths } from "../runner/state.js";
import { standingWalletJournals } from "../runner/standing-service.js";
import { authorJournalPath, rehearsalWalletJournals } from "../rehearsal/submission-verification.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-journals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const STATE = `${homedir()}/.local/state/orynq-midnight`;

// The mainnet scripts and the standing service share one wallet and one state file
// (runner/STANDING.md): each opens it with every journal any of them records its fees in.
describe("the journals of the shared mainnet wallet", () => {
  it("are every mainnet script's and the standing service's", () => {
    const { root, deployJournal, anchorsJournal } = mainnetPaths();
    expect(MAINNET_WALLET_JOURNALS).toEqual([deployJournal, anchorsJournal, proofReleaseJournal(root), `${STATE}/standing/attempts.sqlite`]);
  });

  it("are what the standing service opens the mainnet wallet with, from the state root runner/STANDING.md names", () => {
    expect(standingWalletJournals({ network: "mainnet", stateRoot: `${STATE}/standing` })).toEqual(MAINNET_WALLET_JOURNALS);
  });

  it("refuse a mainnet standing state root whose journal the mainnet scripts would not consult", () => {
    expect(() => standingWalletJournals({ network: "mainnet", stateRoot: join(dir, "standing") })).toThrow(
      `the mainnet standing state root ${join(dir, "standing")} keeps its journal outside the journals the shared mainnet wallet is opened with (${MAINNET_WALLET_JOURNALS.join(", ")})`,
    );
  });

  it("off mainnet are the standing service's own", () => {
    expect(standingWalletJournals({ network: "preprod", stateRoot: join(dir, "preprod") })).toEqual([join(dir, "preprod", "attempts.sqlite")]);
  });
});

// The rehearsal's run and its crash drill share wallet A and its state file.
describe("the journals of the rehearsal's wallets", () => {
  it("are the deploy journal and each author key's journal", () => {
    const secrets = mkdtempSync(join(dir, "secrets-"));
    for (const key of ["author-relay.key", "author-relay-2.key"]) createAuthorKeyFile(join(secrets, key));
    expect(rehearsalWalletJournals(secrets)).toEqual([`${secrets}/journal-deploy.sqlite`, authorJournalPath(secrets, `${secrets}/author-relay.key`), authorJournalPath(secrets, `${secrets}/author-relay-2.key`)]);
  });

  it("leave out an author key the rehearsal has not made yet", () => {
    const secrets = mkdtempSync(join(dir, "secrets-"));
    createAuthorKeyFile(join(secrets, "author-relay.key"));
    writeFileSync(join(secrets, "unrelated.key"), "");
    expect(rehearsalWalletJournals(secrets)).toEqual([`${secrets}/journal-deploy.sqlite`, authorJournalPath(secrets, `${secrets}/author-relay.key`)]);
  });
});
