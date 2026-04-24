# Materios Blob Gateway

Express.js service that stores and serves blob data for the Materios receipt pipeline. Blob data (manifests + chunks) is uploaded before on-chain receipt submission, then verified by the cert daemon committee.

## Architecture

```
SDK / Operator  -->  Blob Gateway  -->  Disk storage (/data/blobs)
                         |                    |
                         v                    v
                   SQLite (quotas)    Cert Daemon reads blobs
                         |
                         v
                   Materios RPC node (funded-account checks)
```

- **Runtime**: Node.js 20, TypeScript, Express
- **Storage**: Local filesystem for blobs, SQLite for quota tracking
- **Deployment**: K8s namespace `materios`, single replica (SQLite constraint)
- **Image**: `ghcr.io/flux-point-studios/materios-blob-gateway:latest`
- **Port**: 3000 (internal), exposed at `https://materios.fluxpointstudios.com/blobs/`

## Endpoints

### Public (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/status` | System status |
| `GET` | `/blobs/:contentHash/status` | Blob certification status |
| `GET` | `/heartbeats/status` | Validator heartbeat status |
| `GET` | `/locators/:receiptId` | Resolve receipt to blob location |
| `GET` | `/chunks/:receiptId/:i` | Download chunk by index |
| `GET` | `/batches/:anchorId` | Batch metadata for Merkle verification |

### Authenticated (signature or API key)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/blobs/:contentHash/manifest` | Upload blob manifest |
| `PUT` | `/blobs/:contentHash/chunks/:i` | Upload chunk data |
| `PATCH` | `/blobs/:contentHash/certified` | Mark blob as certified |
| `POST` | `/heartbeats` | Submit validator heartbeat (dual-mode auth) |
| `POST` | `/batches/:anchorId` | Create batch metadata |
| `PUT` | `/batches/:anchorId` | Update batch metadata |

### Admin-only (x-admin-token)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/token` | Mint a new Bearer token for an operator (returns plaintext ONCE) |
| `DELETE` | `/auth/token/:hash` | Revoke a token by its sha256 hash |
| `GET` | `/auth/tokens` | List all tokens (hashes + metadata; never raw tokens) |

All three require `x-admin-token: <DAEMON_NOTIFY_TOKEN>` in headers.

## Authentication

Four-tier auth model resolved by `resolveAuth()` in `src/auth.ts`:

| Tier | Auth mechanism | Upload quota |
|------|----------------|-------------|
| **bearer** | `Authorization: Bearer matra_<token>` (preferred, revocable, hashed) | Same as api-key |
| **sig-only** | sr25519 signature + funded on-chain account | 10 receipts/day, 256 MB/day, 3 concurrent |
| **api-key** | `x-api-key` header (legacy random-hex key) | Per-key (default 100/day, 1 GB/day, 5 concurrent) |
| **api-key-legacy-ss58** | `x-api-key` header containing the operator's SS58 address (**deprecated**; each call is warn-logged) | Per-key quotas |
| **registered-validator** | Signature + committee registry membership | API-key-level quotas |

### Bearer Tokens (Preferred)

Bearer tokens are the new default. They are:

- **Opaque** — `matra_<43 base62 chars>`, 256 bits of entropy from `crypto.randomBytes`.
- **Hashed at rest** — only `sha256(token)` is stored in `operators.db:api_tokens`.
- **Shown once** — returned by `POST /auth/token` and never again. Lost token => mint a new one.
- **Revocable** — `DELETE /auth/token/:hash` marks `revoked_at`; the middleware rejects subsequent requests.
- **Auditable** — every successful verify updates `last_used_at`; `listTokens()` exposes activity.

#### How to get a token

Ask an admin (someone with `x-admin-token` access) to mint one for your SS58:

```bash
curl -X POST https://materios.fluxpointstudios.com/preprod-blobs/auth/token \
  -H "x-admin-token: <shared-admin-secret>" \
  -H "content-type: application/json" \
  -d '{"account":"5YourSs58Address...","label":"penny-macbook"}'
# {
#   "status": "created",
#   "token": "matra_AbCdEf...",         <-- store NOW, only shown once
#   "tokenHash": "3fa8...64 hex...",
#   ...
# }
```

Or from inside the gateway container:

```bash
docker exec materios-node-blob-gateway-preprod-1 \
  node /app/bin/issue-token.mjs --account 5Your... --label "penny-macbook"
```

#### How to use a token

```bash
curl -H "Authorization: Bearer matra_AbCdEf..." \
     https://materios.fluxpointstudios.com/preprod-blobs/blobs/<hash>/status
```

For clients built on `@fluxpointstudios/orynq-sdk-anchors-materios`, set the
`apiKey` field of `BlobGatewayConfig` to the raw Bearer token. The SDK already
forwards via `x-api-key` today; until the SDK is upgraded (follow-up PR), wrap
your own fetch call that sends `Authorization: Bearer ...`.

#### How to rotate

1. Mint a new token with a fresh label (e.g. `"penny-macbook-2026-05"`).
2. Update the client config / env var (`MATERIOS_BLOB_GATEWAY_TOKEN`).
3. Restart the client, confirm it works.
4. Revoke the old token: `curl -X DELETE .../auth/token/<old-hash> -H "x-admin-token: ..."`.

### Legacy SS58-as-API-key (Deprecated)

Historically operators sent their SS58 address as the API key (`x-api-key: <ss58>`).
This is still accepted for backwards compatibility but:

- Every such call emits a structured warn log — grep for `deprecated-ss58-auth`
  in blob-gateway logs to track clients that haven't migrated.
- The secret is an operator's public on-chain identity — anyone watching the
  explorer can guess it. It will be removed in a future PR after all clients
  have migrated.

Sample migration-tracking grep:

```bash
docker logs materios-node-blob-gateway-preprod-1 2>&1 \
  | grep deprecated-ss58-auth \
  | awk '{print $4}' | sort | uniq -c | sort -rn
```

### Upload Signing Protocol

Signing string format:

```
materios-upload-v1|{contentHash}|{uploaderAddress}|{timestamp}
```

Required headers:

- `x-upload-sig` -- hex-encoded sr25519 signature
- `x-uploader-address` -- SS58 address
- `x-upload-ts` -- Unix timestamp (seconds)

Clock skew tolerance: 120 seconds (configurable via `UPLOAD_SIG_MAX_AGE_SEC`).

### Anti-Spam (Three Layers)

1. **Funded account check** via RPC -- returns true on RPC failure (graceful degradation)
2. **Per-identity quotas** tracked in SQLite
3. **Deferred orphan cleanup** -- blobs with no on-chain receipt after 24 hours are deleted

### Sponsored-Receipt Submission (Optional)

Some clients can upload blobs but cannot sign the on-chain `orinqReceipts.submitReceipt` extrinsic — e.g. OpenHome community abilities, whose Python sandbox has no sr25519 primitives. Without a receipt the blob is an orphan the cert-daemon never sees, and it gets reaped after `RECEIPT_GRACE_HOURS`.

When `SPONSORED_RECEIPT_SUBMITTER_URL` is configured, the gateway fires a fire-and-forget POST to that URL the moment a sponsored-tier upload (Bearer, api-key, or api-key-legacy-ss58) completes. Contract:

```
POST <SPONSORED_RECEIPT_SUBMITTER_URL>
Headers:
  content-type: application/json
  authorization: Bearer <SPONSORED_RECEIPT_SUBMITTER_TOKEN>   (if set)
Body:
  {
    "contentHash":  "<64 hex, no 0x>",
    "operator":     "<SS58 the upload was authed against>",
    "authTier":     "bearer" | "api-key" | "api-key-legacy-ss58",
    "rootHash":     "<optional 64 hex from the manifest>",
    "manifestHash": "<sha256 of the canonical manifest JSON>",
    "source":       "blob-gateway"
  }
Expected response:
  2xx → gateway considers receipt delegated, moves on
  non-2xx → warn-logged; blob still counts as uploaded; normal orphan-cleanup applies
```

The submitter is a separate service (not provided by this repo today) that holds the operator signing keys and turns the notification into an on-chain receipt. Signing infra never touches the gateway process. When the URL is unset (default), the hook is a no-op and non-sponsored sig-only flows with their own signers are unaffected.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `STORAGE_PATH` | `/data/blobs` | Blob storage directory |
| `MATERIOS_RPC_URL` | `ws://materios-rpc.materios.svc.cluster.local:9945` | Substrate RPC endpoint |
| `MIN_UPLOAD_BALANCE` | `1000000` (1 MATRA at 6-dec) | Minimum balance for sig-only uploads |
| `BALANCE_CACHE_TTL_MS` | `300000` (5 min) | Balance check cache duration |
| `UPLOAD_SIG_MAX_AGE_SEC` | `120` | Max signature age |
| `SIG_ONLY_MAX_RECEIPTS_PER_DAY` | `10` | Sig-only daily receipt limit |
| `SIG_ONLY_MAX_BYTES_PER_DAY` | `268435456` (256 MB) | Sig-only daily byte limit |
| `SIG_ONLY_MAX_CONCURRENT_UPLOADS` | `3` | Sig-only concurrent upload limit |
| `RECEIPT_GRACE_HOURS` | `24` | Hours before orphan blobs are eligible for cleanup |
| `BLOB_TTL_AFTER_CERT_DAYS` | `30` | Days to retain blobs after certification |
| `BLOB_TTL_MAX_DAYS` | `90` | Maximum blob retention |
| `KEYS_FILE_PATH` | `/data/blobs/keys.json` | API key definitions file |
| `GATEWAY_BASE_URL` | -- | External base URL for locator responses |
| `MAX_CHUNK_BYTES` | `67108864` (64 MB) | Maximum size per chunk |
| `MAX_CHUNKS_PER_MANIFEST` | `256` | Maximum chunks per manifest |
| `UPLOAD_TIMEOUT_MS` | `300000` (5 min) | Upload request timeout |
| `SPONSORED_RECEIPT_SUBMITTER_URL` | `""` (disabled) | Optional. When set, completed Bearer/api-key-authed uploads POST `{contentHash, operator, authTier, rootHash?, manifestHash, source:"blob-gateway"}` here so an external submitter can build + sign the on-chain `orinqReceipts.submitReceipt` extrinsic on the operator's behalf. Enables community abilities (OpenHome etc.) that upload but can't sign. Fire-and-forget; non-2xx responses are warn-logged but do not affect upload success. |
| `SPONSORED_RECEIPT_SUBMITTER_TOKEN` | `""` | Optional bearer token added as `authorization: Bearer <token>` when posting to the submitter. |
| `SPONSORED_RECEIPT_NOTIFY_TIMEOUT_MS` | `5000` | Abort timeout for the submitter POST. |

## Project Structure

```
src/
  index.ts            Express app entry, route mounting
  auth.ts             Unified resolveAuth() for write endpoints (Bearer > api-key > sig)
  bearer-auth.ts      bearerAuth() middleware + adminGuard()
  api-tokens.ts       Issue/verify/revoke/list Bearer tokens (sha256 at rest)
  upload-auth.ts      verifyUploadSig() for sr25519 signatures
  rpc-client.ts       Lazy @polkadot/api singleton, checkFunded(), checkReceiptStatus()
  quota.ts            API key + account quota management (SQLite)
  storage.ts          Blob storage (manifest + chunks on disk)
  cleanup.ts          TTL cleanup + deferred orphan cleanup
  config.ts           Environment variable parsing
  health.ts           Health check logic
  heartbeat-store.ts  Heartbeat state tracking
  notify.ts           Notification helpers
  routes/
    blobs.ts          Manifest/chunk upload, status, certified PATCH
    batches.ts        Batch metadata CRUD
    heartbeats.ts     Validator heartbeat dual-auth
    chunks.ts         Chunk download
    locators.ts       Receipt-to-blob locator resolution
    operators.ts      Invite-only operator registration
    tokens.ts         Admin: /auth/token mint/revoke/list
    status.ts         System status endpoint
bin/
  issue-token.mjs     Admin CLI: mint a Bearer token (JSON stdout)
  revoke-token.mjs    Admin CLI: revoke a Bearer token by hash
k8s/
  configmap.yaml      Environment configuration
  deployment.yaml     K8s Deployment spec
  secret.yaml         Sensitive config (API keys, etc.)
```

## Admin CLI

```bash
# Mint a new token for an operator (inside the container)
docker exec materios-node-blob-gateway-preprod-1 \
  node /app/bin/issue-token.mjs \
    --account 5YourSs58Address... \
    --label "penny-macbook"

# Revoke a token by its sha256 hash
docker exec materios-node-blob-gateway-preprod-1 \
  node /app/bin/revoke-token.mjs \
    --hash 3fa8...<64 hex>... \
    --reason "lost laptop"
```

## Build and Deploy

```bash
# Install dependencies
cd services/blob-gateway
npm install

# Compile TypeScript
npm run build

# Build and push Docker image
docker build -t ghcr.io/flux-point-studios/materios-blob-gateway:latest .
docker push ghcr.io/flux-point-studios/materios-blob-gateway:latest

# Deploy to K8s
kubectl apply -f k8s/configmap.yaml -n materios
kubectl rollout restart deployment materios-blob-gateway -n materios
```

## Operational Notes

- **Single replica only** -- SQLite does not support concurrent writes from multiple pods.
- **NodePort 30300** -- accessible within the cluster Tailscale network.
- **Heartbeat auth** -- heartbeats use dual-mode auth (signature-based with registry lookup; API key optional). Rate limited to 6 req/min per IP at the Nginx layer.
- **Nginx rate limits** (applied on fps-control-plane-001): 30 req/min blob uploads, 120 req/min reads, 60 req/min RPC.
