import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { fetch } from "undici";
import { SNAPSHOT_BUDGET } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import type { openCensusState } from "./census-state.js";

export async function publishCensusPlan(state: ReturnType<typeof openCensusState>, options: {
  network: "mainnet" | "preprod";
  targets: readonly { url: string; apiKey: string }[];
}): Promise<{ objects: number; readbacks: number }> {
  if (options.targets.length !== 2) throw new Error("Publication requires two retained proof stores");
  if (options.network !== "mainnet" && options.network !== "preprod") throw new Error("Unknown publication network");
  const plan = state.currentPlan();
  if (!plan) throw new Error("No active census plan to publish");
  const objects = state.publicationObjects(plan.commitment);
  const members = objects.filter(object => object.kind === "members"), mapping = objects.filter(object => object.kind === "plans");
  if (members.length < 1 || members.length > 64 || objects.length !== members.length + 1 || mapping.length !== 1 || JSON.parse(mapping[0]!.body).network !== options.network) throw new Error("Publication plan network or object count differs");
  const targets = options.targets.map(target => {
    const url = new URL(target.url);
    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const mainnetHost = !isIP(url.hostname.replace(/^\[|\]$/g, "")) && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost");
    if ((options.network === "mainnet" && (url.protocol !== "https:" || !mainnetHost)) || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || !target.apiKey || /[\r\n]/.test(target.apiKey)) throw new Error("Invalid retained proof store publication configuration");
    return { url, apiKey: target.apiKey, loopback };
  });
  if (targets[0]!.url.origin === targets[1]!.url.origin || (!targets.every(target => target.loopback) && targets[0]!.url.hostname === targets[1]!.url.hostname)) throw new Error("Publication copies require distinct proof store hosts");
  const deadline = AbortSignal.timeout(30_000 + 45_000 * (Math.ceil(members.length / 4) + 1)), failed = new AbortController();
  let readbacks = 0;
  for (const object of objects) {
    if (object.key !== `${object.kind}/${object.sha256}` || !/^(members|plans)$/.test(object.kind) || !/^[a-f0-9]{64}$/.test(object.sha256) || createHash("sha256").update(object.body).digest("hex") !== object.sha256) throw new Error("Publication object binding differs");
  }
  const publish = async (object: typeof objects[number]) => {
    const copies = await Promise.allSettled(targets.map(async target => {
      try {
        const url = new URL(target.url);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/midnight/${options.network}/objects/${object.key}`;
        const request = async (method: "GET" | "PUT") => {
          try {
            return await fetch(url, { method, redirect: "error", signal: AbortSignal.any([deadline, failed.signal, AbortSignal.timeout(15_000)]),
              headers: { "user-agent": "orynq-midnight-publisher/1.0", "cache-control": "no-cache", ...(method === "PUT" ? { "content-type": "application/json", "x-api-key": target.apiKey } : {}) },
              ...(method === "PUT" ? { body: object.body } : {}) });
          } catch (error) { throw new Error("Retained proof store publication request failed", { cause: error }); }
        };
        let response = await request("GET");
        if (response.status === 404) {
          await response.body?.cancel();
          const upload = await request("PUT");
          await upload.body?.cancel();
          if (!upload.ok) throw new Error(`Retained proof store publication rejected with HTTP ${upload.status}`);
          response = await request("GET");
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Retained proof store readback rejected with HTTP ${response.status}`);
        }
        const reader = response.body.getReader(), digest = createHash("sha256");
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > SNAPSHOT_BUDGET) { await reader.cancel(); throw new Error("Retained proof store readback exceeds byte budget"); }
            digest.update(chunk.value);
          }
        } finally { reader.releaseLock(); }
        if (digest.digest("hex") !== object.sha256) throw new Error("Retained proof store readback digest differs");
        readbacks++;
      } catch (error) { failed.abort(); throw error; }
    }));
    const rejected = copies.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    state.acknowledgePublication(object.key, object.sha256);
  };
  for (const phase of [members, mapping]) {
    for (let i = 0; i < phase.length; i += 4) {
      const group = await Promise.allSettled(phase.slice(i, i + 4).map(publish));
      const rejected = group.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }
  return { objects: objects.length, readbacks };
}
