import type { ApiPromise } from "@polkadot/api";
import type { MateriosFeeShortfall } from "./errors.js";

/** Reads `account` at the best block to tell an unregistered account from a MOTRA shortfall. */
export async function readFeeShortfall(api: ApiPromise, account: string): Promise<MateriosFeeShortfall> {
  type Count = { toNumber(): number };
  const info = await api.query.system!.account!(account) as unknown as { providers: Count; sufficients: Count };
  const providers = info.providers.toNumber();
  const sufficients = info.sufficients.toNumber();
  const reason = providers === 0 && sufficients === 0 ? "unregistered-account" : "insufficient-motra";
  return { reason, account, providers, sufficients };
}
