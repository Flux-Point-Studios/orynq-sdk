import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthorKeyFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MAINNET_WALLET_JOURNALS, MAINNET_WALLET_STATE } from "../src/mainnet-state.js";
import { proofReleaseJournal } from "../src/proof-release.js";
import { mainnetPaths } from "../runner/state.js";
import { standingWalletJournals } from "../runner/standing-service.js";
import { authorJournalPath, rehearsalWalletJournals } from "../rehearsal/submission-verification.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-journals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const STATE = `${homedir()}/.local/state/orynq-midnight`;
const SHARED = `${STATE}/mainnet-wallet.state.json`;

// The mainnet scripts and the standing service share one wallet and one state file
// (runner/STANDING.md): each opens it with every journal any of them records its fees in.
describe("the journals of the shared mainnet wallet", () => {
  it("are every mainnet script's and the standing service's", () => {
    const { root, deployJournal, anchorsJournal } = mainnetPaths();
    expect(MAINNET_WALLET_JOURNALS).toEqual([deployJournal, anchorsJournal, proofReleaseJournal(root), `${STATE}/standing/attempts.sqlite`]);
  });

  it("are what the standing service opens the mainnet wallet with, from the state root runner/STANDING.md names", () => {
    expect(MAINNET_WALLET_STATE).toBe(SHARED);
    expect(standingWalletJournals({ network: "mainnet", stateRoot: `${STATE}/standing`, wallet: { state: SHARED } })).toEqual(MAINNET_WALLET_JOURNALS);
  });

  it("refuse a mainnet standing state root whose journal the mainnet scripts would not consult", () => {
    expect(() => standingWalletJournals({ network: "mainnet", stateRoot: join(dir, "standing"), wallet: { state: SHARED } })).toThrow(
      `the mainnet standing state root ${join(dir, "standing")} keeps its journal outside the journals the shared mainnet wallet is opened with (${MAINNET_WALLET_JOURNALS.join(", ")})`,
    );
  });

  it("refuse a mainnet standing wallet state file other than the one the mainnet scripts share", () => {
    for (const state of [join(dir, "mainnet-wallet.state.json"), `${SHARED}.copy`, `${STATE}/standing/mainnet-wallet.state.json`]) {
      expect(() => standingWalletJournals({ network: "mainnet", stateRoot: `${STATE}/standing`, wallet: { state } })).toThrow(
        `the mainnet standing wallet state ${state} is not the state file the shared mainnet wallet is opened with (${SHARED})`,
      );
    }
  });

  // The journals are named from the process's HOME. Started under another HOME, the service
  // would consult that HOME's journals, so it must not open the wallet state the mainnet
  // scripts keep under theirs, whose pending fees are in journals it does not read.
  it("refuse the shared mainnet wallet state under another HOME, whose journals are not the ones that state's fees are recorded in", () => {
    const home = mkdtempSync(join(dir, "home-"));
    const journals = (state: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'import { standingWalletJournals } from "./runner/standing-service.ts"; try { console.log(JSON.stringify(standingWalletJournals(JSON.parse(process.argv[1])))); } catch (error) { console.error(error.message); process.exitCode = 1; }',
      JSON.stringify({ network: "mainnet", stateRoot: `${home}/.local/state/orynq-midnight/standing`, wallet: { state } })], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 });
    const own = `${home}/.local/state/orynq-midnight/mainnet-wallet.state.json`;
    const refused = journals(SHARED);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`the mainnet standing wallet state ${SHARED} is not the state file the shared mainnet wallet is opened with (${own})`);
    const accepted = journals(own);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toContain(`${home}/.local/state/orynq-midnight/standing/attempts.sqlite`);
  }, 270_000);

  it("off mainnet are the standing service's own, whatever state file the wallet keeps", () => {
    expect(standingWalletJournals({ network: "preprod", stateRoot: join(dir, "preprod"), wallet: { state: join(dir, "wallet.state") } })).toEqual([join(dir, "preprod", "attempts.sqlite")]);
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
