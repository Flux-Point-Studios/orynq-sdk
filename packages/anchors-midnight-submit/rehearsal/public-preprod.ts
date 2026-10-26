import { NodeError } from "../../anchors-midnight/src/source.js";

const URL = "wss://rpc.preprod.midnight.network";
const GENESIS = "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b";
type Socket = Pick<WebSocket, "send" | "close" | "addEventListener" | "removeEventListener">;

// A credential-free large-body submission path. Pin the chain on the same WebSocket before
// sending; node acceptance is only delivery, never inclusion/finality. Read providers do not change.
export async function submitPublicPreprod(extrinsic: unknown, socket = (url: string): Socket => new WebSocket(url), timeoutMs = 30_000): Promise<string> {
  if (typeof extrinsic !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(extrinsic) || extrinsic.length > 16 * 1024 * 1024) throw new Error("Invalid public preprod extrinsic");
  const steps = [
    { method: "system_chain", params: [], accepts: (result: any) => result === "Midnight Preprod" },
    { method: "chain_getBlockHash", params: [0], accepts: (result: any) => result === `0x${GENESIS}` },
    { method: "state_getRuntimeVersion", params: [], accepts: (result: any) => result?.specVersion === 1000300 },
    { method: "author_submitExtrinsic", params: [extrinsic], accepts: (result: any) => typeof result === "string" && /^0x[0-9a-f]{64}$/i.test(result) },
  ];
  return new Promise((resolve, reject) => {
    let peer: Socket, step = 0, settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      peer?.removeEventListener("open", open); peer?.removeEventListener("message", message);
      peer?.removeEventListener("error", unavailable); peer?.removeEventListener("close", unavailable);
      peer?.close();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Public preprod WebSocket request timed out")), timeoutMs);
    const send = () => peer.send(JSON.stringify({ jsonrpc: "2.0", id: step + 1, method: steps[step]!.method, params: steps[step]!.params }));
    const open = () => send();
    const unavailable = () => finish(new Error("Public preprod WebSocket request unavailable"));
    const message = (event: MessageEvent) => {
      if (settled) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 4096) throw new Error("Malformed public preprod WebSocket response");
        const answer = JSON.parse(event.data);
        if (answer.jsonrpc !== "2.0" || answer.id !== step + 1) throw new Error("Mismatched public preprod WebSocket response");
        if (answer.error) {
          const method = steps[step]!.method;
          if (!Number.isSafeInteger(answer.error.code)) throw new Error("Malformed public preprod node error");
          const message = typeof answer.error.message === "string" && /^[A-Za-z0-9 .:_()-]{1,160}$/.test(answer.error.message) ? answer.error.message : "Node refused request";
          const data = typeof answer.error.data === "string" && /^Custom error: [0-9]{1,6}$/.test(answer.error.data) ? answer.error.data : undefined;
          return finish(new NodeError(`midnight node: ${method} failed: ${JSON.stringify({ code: answer.error.code, message, ...(data ? { data } : {}) })}`, method, answer.error.code));
        }
        if (!steps[step]!.accepts(answer.result)) throw new Error("Public preprod node identity or response does not match its pin");
        if (++step === steps.length) return finish(undefined, answer.result);
        send();
      } catch (error) { finish(error instanceof Error ? error : new Error("Public preprod WebSocket response unavailable")); }
    };
    try {
      peer = socket(URL);
      peer.addEventListener("open", open); peer.addEventListener("message", message as EventListener);
      peer.addEventListener("error", unavailable); peer.addEventListener("close", unavailable);
    } catch { finish(new Error("Public preprod WebSocket request unavailable")); }
  });
}
