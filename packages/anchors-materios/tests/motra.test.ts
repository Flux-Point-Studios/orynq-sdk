import { describe, expect, it, vi } from "vitest";
import { MateriosFeeError, waitForMotra, type MateriosProvider } from "../src/index.js";

const SIGNER = "5MotraSigner";
const count = (n: number) => ({ toNumber: () => n });

function stub({ providers, sufficients = 0, balance }: { providers: number; sufficients?: number; balance: bigint }) {
  const account = vi.fn(async (_who: string) => ({ providers: count(providers), sufficients: count(sufficients) }));
  const send = vi.fn(async (_method: string, _params: unknown[]) => ({ balance: balance.toString() }));
  const provider = {
    getApi: () => ({ _rpcCore: { provider: { send } }, query: { system: { account } } }),
    getKeypair: () => ({ address: SIGNER }),
  } as unknown as MateriosProvider;
  return { provider, account, send };
}

const timedOut = (provider: MateriosProvider, minBalance: bigint) =>
  waitForMotra(provider, minBalance, { intervalMs: 5, timeoutMs: 20 }).then(
    value => { throw new Error(`expected a timeout, got ${value}`); },
    (error: unknown) => error as MateriosFeeError,
  );

describe("waitForMotra", () => {
  it("returns the balance once it reaches the minimum, without reading the account", async () => {
    const { provider, account, send } = stub({ providers: 0, balance: 10n });
    await expect(waitForMotra(provider, 10n, { intervalMs: 5, timeoutMs: 20 })).resolves.toBe(10n);
    expect(send).toHaveBeenCalledWith("motra_getBalance", [SIGNER]);
    expect(account).not.toHaveBeenCalled();
  });

  it("times out with an unregistered-account error when the signer has no provider or sufficient reference", async () => {
    const { provider, account } = stub({ providers: 0, balance: 0n });
    const error = await timedOut(provider, 10n);
    expect(error).toBeInstanceOf(MateriosFeeError);
    expect(error).toMatchObject({ name: "MateriosFeeError", balance: 0n, minBalance: 10n });
    expect(error.shortfall).toEqual({ reason: "unregistered-account", account: SIGNER, providers: 0, sufficients: 0 });
    expect(error.message).toMatch(/^MOTRA warm-up timeout after 20ms \(\d+ polls\) with 0 of the 10 MOTRA base units required\. /);
    expect(error.message).toContain(`Materios account ${SIGNER} is not registered`);
    expect(error.message).toContain("Register cMATRA for it on Cardano, or ask the Materios operator for capacity");
    expect(account).toHaveBeenCalledWith(SIGNER);
  });

  it("times out with an insufficient-motra error when the signer is registered", async () => {
    const { provider } = stub({ providers: 1, balance: 5n });
    const error = await timedOut(provider, 10n);
    expect(error).toBeInstanceOf(MateriosFeeError);
    expect(error).toMatchObject({ balance: 5n, minBalance: 10n });
    expect(error.shortfall).toEqual({ reason: "insufficient-motra", account: SIGNER, providers: 1, sufficients: 0 });
    expect(error.message).toContain(`with 5 of the 10 MOTRA base units required. Materios account ${SIGNER} is registered but holds too little MOTRA`);
  });
});
