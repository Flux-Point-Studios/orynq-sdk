import { describe, expect, it } from "vitest";

import { validateEnv } from "../env.js";

const complete = {
  ANCHOR_WORKER_TOKEN: "token",
  BLOCKFROST_PROJECT_ID: "project",
  CARDANO_NETWORK: "preprod",
  WALLET_SEED_PHRASE: "seed",
};

describe("validateEnv", () => {
  it("accepts a complete environment", () => {
    expect(() => validateEnv(complete)).not.toThrow();
  });

  it("names CARDANO_NETWORK when it is unset, instead of defaulting to a chain", () => {
    expect(() => validateEnv({ ...complete, CARDANO_NETWORK: undefined })).toThrow(
      "Missing required environment variables: CARDANO_NETWORK"
    );
  });

  it("names every missing variable at once", () => {
    expect(() => validateEnv({})).toThrow(
      "Missing required environment variables: ANCHOR_WORKER_TOKEN, BLOCKFROST_PROJECT_ID, CARDANO_NETWORK, WALLET_SEED_PHRASE"
    );
  });

  it("rejects a network name the worker cannot anchor on", () => {
    expect(() => validateEnv({ ...complete, CARDANO_NETWORK: "Preprod" })).toThrow(
      'CARDANO_NETWORK must be one of mainnet, preprod, preview (got "Preprod")'
    );
  });
});
