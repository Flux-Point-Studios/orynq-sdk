import { describe, expect, it } from "vitest";

import { anchorErrorBody } from "../error-response.js";

describe("anchor error response", () => {
  it("names the network, so a client never has to guess it", () => {
    /** A client that cannot see the network in a failure has to fall back on
     * its own default. openclaw's default is mainnet, which is how 224 preprod
     * failures were reported as mainnet and nearly funded the wrong chain. */
    const body = anchorErrorBody(new Error("boom"), "preprod", 2222);
    expect(body.network).toBe("preprod");
  });

  it("names the label too", () => {
    expect(anchorErrorBody(new Error("boom"), "preprod", 2222).label).toBe(2222);
  });

  it("still reports failure and the message", () => {
    const body = anchorErrorBody(new Error("insufficient funds"), "preprod", 2222);
    expect(body.success).toBe(false);
    expect(body.error).toBe("insufficient funds");
  });

  it("survives a thrown non-Error", () => {
    const body = anchorErrorBody("just a string", "mainnet", 2222);
    expect(body.error).toBe("Unknown error occurred");
    expect(body.network).toBe("mainnet");
  });

  it("carries the same network and label keys the success path uses", () => {
    /** Asymmetry between the two shapes is what lets a client read one and
     * mis-handle the other. */
    const body = anchorErrorBody(new Error("x"), "preprod", 2222);
    expect(Object.keys(body).sort()).toEqual(["error", "label", "network", "success"]);
  });
});
