import type { ApiPromise, SubmittableResult } from "@polkadot/api";

/** A dispatch error decoded to `section.name` with its documentation. */
export interface DispatchFailure {
  name: string;
  message: string;
}

export type WatchOutcome =
  | { status: "included"; blockHash: string; blockNumber: number }
  | { status: "failed"; blockHash: string; failure: DispatchFailure }
  /** The node never accepted the transaction (pool refusal), or it was never sent. */
  | { status: "refused"; cause: Error }
  /** The transaction may have reached the pool; only storage can tell whether it lands. */
  | { status: "lost"; cause: Error; timedOut: boolean };

/** Transaction-pool refusals: invalid (1010), unknown validity (1011), priority too low (1014). */
const POOL_REFUSALS = new Set([1010, 1011, 1014]);
/** polkadot.js throws this before writing a request to a closed socket. */
const NOT_SENT = "WebSocket is not connected";

type DispatchError = NonNullable<SubmittableResult["dispatchError"]>;

export function describeDispatch(api: ApiPromise, error: DispatchError): DispatchFailure {
  if (!error.isModule) return { name: error.toString(), message: error.toString() };
  const decoded = api.registry.findMetaError(error.asModule);
  const name = `${decoded.section}.${decoded.name}`;
  return { name, message: `${name}: ${decoded.docs.join(" ")}` };
}

const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

function sendFailure(error: unknown): WatchOutcome {
  const cause = asError(error);
  const code = (cause as { code?: unknown }).code;
  return (typeof code === "number" && POOL_REFUSALS.has(code)) || cause.message === NOT_SENT
    ? { status: "refused", cause }
    : { status: "lost", cause, timedOut: false };
}

/**
 * Sends a signed extrinsic and watches it until inclusion (a best block, or a finalized block when
 * `finalized`), a dispatch failure, a refusal, or the loss of the watch. Settles at `deadline`
 * at the latest and always releases its timer, listener and subscription.
 */
export function watchSubmission(
  api: ApiPromise,
  send: (callback: (result: SubmittableResult) => void) => Promise<() => void>,
  deadline: number,
  finalized: boolean,
): Promise<WatchOutcome> {
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const stop = () => {
      const unsubscribeNow = unsubscribe;
      unsubscribe = undefined;
      if (unsubscribeNow) {
        try { unsubscribeNow(); }
        catch (error) { console.warn(`[materios-sdk] Could not unsubscribe transaction watch: ${asError(error).message}`); }
      }
    };
    const finish = (outcome: WatchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.off("disconnected", disconnected);
      stop();
      resolve(outcome);
    };
    const disconnected = () => finish({ status: "lost", cause: new Error("Connection closed while watching the transaction"), timedOut: false });
    const timer = setTimeout(() => finish({ status: "lost", cause: new Error("No inclusion status before the watch deadline"), timedOut: true }),
      Math.max(0, deadline - Date.now()));
    api.on("disconnected", disconnected);
    if (!api.isConnected) {
      finish({ status: "refused", cause: new Error(NOT_SENT) });
      return;
    }
    try {
      send(result => {
        if (settled) return;
        try {
          const { status, dispatchError, internalError, blockNumber } = result;
          const blockHash = () => (status.isInBlock ? status.asInBlock : status.asFinalized).toHex();
          if (dispatchError) {
            finish({ status: "failed", blockHash: blockHash(), failure: describeDispatch(api, dispatchError) });
          } else if (status.isFinalized || (!finalized && status.isInBlock)) {
            // Without the block's events polkadot.js cannot report a dispatch failure.
            finish(blockNumber && !internalError
              ? { status: "included", blockHash: blockHash(), blockNumber: blockNumber.toNumber() }
              : { status: "lost", cause: internalError ?? new Error(`Extrinsic not found in block ${blockHash()}`), timedOut: false });
          } else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout) {
            finish({ status: "lost", cause: new Error(`Transaction pool reported ${status.type}`), timedOut: false });
          }
        } catch (error) {
          finish({ status: "lost", cause: asError(error), timedOut: false });
        }
      }).then(unsub => {
        unsubscribe = unsub;
        if (settled) stop();
      }, error => finish(sendFailure(error)));
    } catch (error) {
      finish({ status: "lost", cause: asError(error), timedOut: false });
    }
  });
}
