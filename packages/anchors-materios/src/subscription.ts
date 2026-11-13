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
  /**
   * The transaction may have reached the pool; only storage can tell whether it lands. `silent`
   * marks a watch that timed out on a socket that carried nothing for it: no reply to the
   * submission and no status. A watch that timed out after either was only slower than its window.
   */
  | { status: "lost"; cause: Error; timedOut: boolean; silent: boolean };

/**
 * Transaction-pool refusals, after which the pool does not hold the transaction: invalid (1010),
 * unknown validity (1011), priority too low (1014), pool full (1016). Temporarily banned (1012)
 * and already imported (1013) are not refusals: that transaction may be pooled or included.
 */
const POOL_REFUSALS = new Set([1010, 1011, 1014, 1016]);
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
    : lost(cause);
}

const lost = (cause: Error): WatchOutcome => ({ status: "lost", cause, timedOut: false, silent: false });

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
    /** The socket answered the submission or reported a status for it. */
    let answered = false;
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
    const disconnected = () => finish(lost(new Error("Connection closed while watching the transaction")));
    const timer = setTimeout(
      () => finish({ status: "lost", cause: new Error("No inclusion status before the watch deadline"), timedOut: true, silent: !answered }),
      Math.max(0, deadline - Date.now()));
    api.on("disconnected", disconnected);
    if (!api.isConnected) {
      finish({ status: "refused", cause: new Error(NOT_SENT) });
      return;
    }
    try {
      send(result => {
        answered = true;
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
              : lost(internalError ?? new Error(`Extrinsic not found in block ${blockHash()}`)));
          } else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout) {
            finish(lost(new Error(`Transaction pool reported ${status.type}`)));
          }
        } catch (error) {
          finish(lost(asError(error)));
        }
      }).then(unsub => {
        answered = true;
        unsubscribe = unsub;
        if (settled) stop();
      }, error => finish(sendFailure(error)));
    } catch (error) {
      finish(lost(asError(error)));
    }
  });
}
