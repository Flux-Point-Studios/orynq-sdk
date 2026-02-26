/**
 * Materios anchor chain provider.
 *
 * Connects to a Materios Substrate node via @polkadot/api and provides
 * methods to submit and query anchors via the OrinqReceipts pallet.
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { MateriosAnchorConfig } from "./types.js";

export class MateriosProvider {
  private api: ApiPromise | null = null;
  private keypair: KeyringPair | null = null;
  private config: MateriosAnchorConfig;

  constructor(config: MateriosAnchorConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const provider = new WsProvider(this.config.rpcUrl);
    this.api = await ApiPromise.create({ provider });
    const keyring = new Keyring({ type: "sr25519" });
    this.keypair = keyring.addFromUri(this.config.signerUri);
  }

  async disconnect(): Promise<void> {
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
  }

  getApi(): ApiPromise {
    if (!this.api) throw new Error("Not connected. Call connect() first.");
    return this.api;
  }

  getKeypair(): KeyringPair {
    if (!this.keypair) throw new Error("Not connected. Call connect() first.");
    return this.keypair;
  }
}
