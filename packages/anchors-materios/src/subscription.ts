import type { ApiPromise, SubmittableResult } from "@polkadot/api";
import { MateriosSubmissionError } from "./errors.js";

/** Null means the watch cannot establish inclusion; storage must decide the outcome. */
export function watchSubmission(
  api: ApiPromise,
  start: (callback: (result: SubmittableResult) => void) => Promise<() => void>,
  deadline: number,
  id: string,
  finalized: boolean,
): Promise<SubmittableResult | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const stop = () => {
      const unsubscribeNow = unsubscribe;
      unsubscribe = undefined;
      if (unsubscribeNow) {
        try { unsubscribeNow(); }
        catch { console.warn("[materios-sdk] Could not unsubscribe transaction watch"); }
      }
    };
    const finish = (result: SubmittableResult | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.off("disconnected", disconnected);
      stop();
      if (error) reject(error);
      else resolve(result);
    };
    const disconnected = () => finish(null);
    const timer = setTimeout(disconnected, Math.max(0, deadline - Date.now()));
    api.on("disconnected", disconnected);
    if (api.isConnected === false || Date.now() >= deadline) {
      finish(null);
      return;
    }
    try {
      start((result) => {
        if (settled) return;
        try {
          const { status, dispatchError } = result;
          if (dispatchError) {
            const decoded = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
            const message = decoded ? `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}` : dispatchError.toString();
            finish(null, new MateriosSubmissionError("dispatch", id, message));
          } else if (finalized ? status.isFinalized : status.isInBlock) {
            finish(result);
          } else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout) {
            finish(null);
          }
        } catch (error) {
          finish(null, new MateriosSubmissionError("inclusion-unknown", id, "Could not interpret transaction status; do not blindly resubmit", { cause: error }));
        }
      }).then((unsub) => {
        unsubscribe = unsub;
        if (settled) stop();
      }, () => finish(null));
    } catch (error) {
      finish(null, new MateriosSubmissionError("inclusion-unknown", id, "Transaction watch failed; do not blindly resubmit", { cause: error }));
    }
  });
}
