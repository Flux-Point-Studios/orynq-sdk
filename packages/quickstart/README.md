# @fluxpointstudios/orynq-sdk-quickstart

Solo-developer quickstart for orynq. Get from `npm install` to a chain-anchored first trace in under 5 minutes — no signer URI to manage, no wallet to seed, no Cardano addresses to look up.

## Installation

```bash
npm install --global @fluxpointstudios/orynq-sdk-quickstart
```

## CLI

```bash
orynq init       # Generate identity + faucet-drip MATRA. Idempotent.
orynq trace      # Build + submit a chain-anchored first trace.
orynq whoami     # Print the saved SS58 address.
orynq status     # Show gateway + chain health.
orynq help       # Show usage.
```

## Midnight anchors

```bash
orynq verify midnight <txHash> [--bundle bundle.json [--hidden]] [--author <key>]
orynq verify midnight bundle.json --tx <txHash> [--hidden]
orynq keys init midnight --out ~/.orynq/midnight-key.json
orynq anchor midnight --network mainnet --key ~/.orynq/midnight-key.json --bundle bundle.json [--hidden] [--submit]
```

`orynq verify midnight` is read-only and needs no key and no DUST. It checks an anchor with
`verifyMidnightAnchor` from `@fluxpointstudios/orynq-sdk-anchors-midnight` and prints its labels:

- `status`: `valid` (exit 0) or the first of `invalid`, `conflict`, `unavailable`,
  `unverified-finality`, `unauthenticated` and `author-revoked` (exit 1).
- `assurance`: how far inclusion is shown. `consensus-verified` means the transaction is in a block
  GRANDPA finalized; `multi-path` and `single-path` mean sources agree, or one source says so.
- `author`: the anchor's author key, as KNOWN_AUTHORS lists it, or as you named it with `--author`.
- `matched`: what the anchor's commitment binds that your bundle supplied. Kind 1 binds the
  bundle's `rootHash`, `manifestHash` and `merkleRoot`; kind 2 (`--hidden`) binds only the
  attribute, the bundle's model manifest hash. A bare transaction hash matches nothing: the
  commitment is printed, not checked.
- every check, with what it found. `--json` prints the same report as JSON.

A bundle must be intact (its events and model manifest hash to its own `rootHash` and
`merkleRoot`) and carry the `manifestHash` of its storage manifest, the same entry a Cardano
anchor of the bundle commits to. The source is Blockfrost (`--blockfrost-file <file>`, a file only
you can read that holds the project id, or `ORYNQ_MIDNIGHT_BLOCKFROST_FILE`), or any Midnight
indexer and node (`--indexer <graphql url> --rpc <json-rpc url>`). `--network` is `mainnet` (the
default) or `preprod`. Text a source sends is printed without control characters and cut at 300
characters.

`orynq anchor midnight` anchors with your own key only. `orynq keys init midnight` writes that key
file: a fresh author secret and a fresh salt key, readable only by you. The command takes nothing
else: a bare author key file, the format service keys use, is refused, and so is any key that
KNOWN_AUTHORS lists on any network, since those are Flux Point Studios keys. Without `--submit` it is
a dry run that prints the plan (network, registry, kind, commitment, attribute, your author key)
and sends nothing. `--submit` needs a person at a terminal: stdin and stderr must both be a TTY, or
it stops before reading any file, and you must type the commitment's first 8 characters to send.
Sending also needs a registry generation deployed on the network and a Midnight submitter. This
release has neither, so `--submit` stops before it asks you to confirm. The TTY check stops scripts and models that run commands through a pipe. It is not
proof of a person: a program that wraps the command in a pseudo-terminal can type the confirmation
too.

## Programmatic API

```typescript
import { bootstrapAndTrace } from "@fluxpointstudios/orynq-sdk-quickstart";

const result = await bootstrapAndTrace({
  // All defaults point at Materios preprod. Set any subset to override.
  agentId: "my-agent",
  summary: "anchored from my CI pipeline",
  onProgress(step) {
    // Optional live progress stream.
    console.log(step.kind);
  },
});

console.log("Trace URL:", result.urls.blobStatus);
console.log("Cert hash:", result.certHash);
```

### Primitives

If you don't want the all-in-one bootstrap, mix and match:

```typescript
import {
  loadOrCreateIdentity,
  requestFaucet,
  firstTraceBundle,
  buildExplorerUrls,
  DEFAULT_RPC_URL,
  DEFAULT_GATEWAY_URL,
} from "@fluxpointstudios/orynq-sdk-quickstart";

const identity = await loadOrCreateIdentity();
await requestFaucet({ address: identity.address, gatewayBaseUrl: DEFAULT_GATEWAY_URL });
const bundle = await firstTraceBundle({ agentId: "my-agent", summary: "hi" });
// ...build your own MateriosProvider, submit, certify...
const urls = buildExplorerUrls({ contentHash, blockHash, gatewayBaseUrl: DEFAULT_GATEWAY_URL, rpcUrl: DEFAULT_RPC_URL });
```

## Env variable overrides

| Env var | Default | Purpose |
|---|---|---|
| `ORYNQ_CONFIG_PATH` | `~/.orynq/config.json` | Identity file location |
| `ORYNQ_RPC_URL` | `wss://materios.fluxpointstudios.com/rpc` | Substrate WS RPC URL |
| `ORYNQ_GATEWAY_URL` | `https://materios.fluxpointstudios.com/blobs` | Blob-gateway base URL |
| `ORYNQ_AGENT_ID` | `orynq-quickstart` | Agent ID stamped on the trace |
| `ORYNQ_SUMMARY` | auto-generated | Observation event content |
| `ORYNQ_SKIP_FAUCET` | `0` | Set to `1` to skip faucet drip |
| `ORYNQ_VERBOSE` | `0` | Set to `1` for extra info on `whoami` |
| `ORYNQ_MIDNIGHT_BLOCKFROST_FILE` | none | Blockfrost project id file for `orynq verify midnight` |

## Trust model

`orynq init` generates a fresh sr25519 keypair and writes the mnemonic to `~/.orynq/config.json` with 0600 permissions (POSIX). On Materios preprod, that address can:

- Faucet-drip test MATRA (one-shot per address)
- Upload blob data to the public gateway via sig-only auth
- Submit `submitReceipt` extrinsics on chain

There is **no** automatic upgrade to a Materios-mainnet identity yet — the preprod identity is meant for "hello world" learning. To move a real workload to mainnet, generate a separate mainnet identity (recommended: hardware-wallet-backed) and point `ORYNQ_RPC_URL` / `ORYNQ_GATEWAY_URL` at the mainnet endpoints.

## Sub-5-minute contract

The package's CI exercises a fresh-install simulation that asserts `bootstrapAndTrace()` completes in under 300 seconds (5 minutes) including faucet drip, MOTRA generation, on-chain submission, and committee certification on Materios preprod.

Measured end-to-end on Gemtek (4-core, 16 GB RAM, residential link, 2026-05-14):

- `npm install --global` — ~10 s
- `orynq trace` (cold start, fresh address, no funds) — 167.9 s
- Total — ~178 s = 2:58, well under the 5-minute bar

`orynq trace` is idempotent — rerunning prints the same identity and submits a new receipt without re-faucet (the per-address ledger reuses the existing balance).

## License

MIT
