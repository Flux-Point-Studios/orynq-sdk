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

## Authentication

Three-tier auth model resolved by `resolveAuth()` in `src/auth.ts`:

| Tier | Auth mechanism | Upload quota |
|------|----------------|-------------|
| **sig-only** | sr25519 signature + funded on-chain account | 10 receipts/day, 256 MB/day, 3 concurrent |
| **api-key** | `x-api-key` header | Per-key (default 100/day, 1 GB/day, 5 concurrent) |
| **registered-validator** | Signature + committee registry membership | API-key-level quotas |

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `STORAGE_PATH` | `/data/blobs` | Blob storage directory |
| `MATERIOS_RPC_URL` | `ws://materios-rpc.materios.svc.cluster.local:9945` | Substrate RPC endpoint |
| `MIN_UPLOAD_BALANCE` | `1000000000000` (1T MATRA) | Minimum balance for sig-only uploads |
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

## Project Structure

```
src/
  index.ts            Express app entry, route mounting
  auth.ts             Unified resolveAuth() for write endpoints
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
    status.ts         System status endpoint
k8s/
  configmap.yaml      Environment configuration
  deployment.yaml     K8s Deployment spec
  secret.yaml         Sensitive config (API keys, etc.)
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
