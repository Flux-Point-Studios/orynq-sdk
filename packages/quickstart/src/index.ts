/**
 * @fluxpointstudios/orynq-sdk-quickstart
 *
 * Solo-developer DX surface. Get from `npm install` to a chain-anchored
 * first trace in under 5 minutes — no signer URI to manage, no wallet to
 * seed, no Cardano addresses to look up.
 *
 * Three layers:
 *
 *   - **CLI** (`bin/orynq.mjs`):    `orynq init`, `orynq trace`,
 *                                    `orynq whoami`, `orynq status`.
 *   - **One-call API**:              `bootstrapAndTrace()` — identity,
 *                                    faucet, submit, certify, URL.
 *   - **Primitives**:                `loadOrCreateIdentity`,
 *                                    `firstTraceBundle`, `requestFaucet`,
 *                                    `buildExplorerUrls`. Mix and match
 *                                    when you're past the hello-world tier.
 *
 * All primitives are pure ESM, zero side-effects on import. The first
 * filesystem write happens only when you call into `loadOrCreateIdentity`
 * (or any helper that wraps it), so this package is safe to require()
 * from a Cloudflare Worker or a Vite client bundle.
 */

export {
  loadOrCreateIdentity,
  defaultConfigPath,
} from "./identity.js";
export type {
  OrynqIdentity,
  LoadOrCreateIdentityOptions,
} from "./identity.js";

export { firstTraceBundle } from "./trace.js";
export type {
  TraceBundleLite,
  FirstTraceBundleOptions,
  DeterministicHooks,
} from "./trace.js";

export { requestFaucet } from "./faucet.js";
export type {
  FaucetDripResult,
  FaucetDripSuccess,
  FaucetDripAlreadyFunded,
  FaucetDripCooldown,
  FaucetDripError,
  RequestFaucetOptions,
} from "./faucet.js";

export { buildExplorerUrls } from "./explorer.js";
export type { ExplorerUrls, BuildExplorerUrlsInput } from "./explorer.js";

export {
  bootstrapAndTrace,
  deriveAddress,
  DEFAULT_RPC_URL,
  DEFAULT_GATEWAY_URL,
  DEFAULT_AGENT_ID,
} from "./bootstrap.js";
export type {
  BootstrapAndTraceOptions,
  BootstrapAndTraceResult,
  BootstrapStep,
} from "./bootstrap.js";

export const VERSION = "0.1.0";
