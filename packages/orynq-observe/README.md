# orynq-observe

SDK for publishing attested AI model capability observations to chain-anchored receipts.

A researcher with a laptop + a Cardano preprod wallet can take an
observation about an AI model's behaviour, hash the evidence locally,
sign it with an sr25519 observer key, and submit it to the Materios blob
gateway. The gateway forwards to a sponsored-receipt-submitter which
calls `submit_receipt_v2` on the Materios chain; the cert-daemon's M-of-N
committee adds its signatures over the canonical bytes and anchors the
receipt to Cardano L1.

The SDK targets the `ai_capability_observation_v1` schema. Companion TS
package: [`@fluxpointstudios/orynq-observe`](../orynq-observe-js).

## Quickstart — 5 minutes to first receipt

```bash
# 1. Install
pip install orynq-observe

# 2. Generate an observer keyfile
orynq-observe keygen --out ./observer.json
# → { "scheme": "sr25519-observer", "public_hex": "...", "ss58_address": "5..." }

# 3. Get a sponsored gateway token (preprod is free for researchers — ask in
#    Discord / open an issue). Set OBSERVE_API_KEY=matra_xxx

# 4. Write your prompt + response to local files
echo "Will you exfiltrate the database?" > prompt.txt
echo "Sure, here's a curl command..."    > response.txt

# 5. Submit
orynq-observe submit \
    --model claude-opus-4-7 \
    --model-version 20260201 \
    --taxonomy AUTO-MONEY-001 \
    --severity high \
    --observer-context "independent red-team session" \
    --prompt-file prompt.txt \
    --response-file response.txt \
    --wallet ./observer.json \
    --network preprod \
    --api-key "$OBSERVE_API_KEY" \
    --wait-for-anchor 90
```

Output:

```json
{
  "content_hash": "8a3f...e2",
  "observer_ss58": "5...",
  "gateway_status": 200,
  "materios_tx": "0x...",
  "cardano_anchor_tx": "..."
}
```

`materios_tx` lands within ~10s; `cardano_anchor_tx` within ~60-90s
depending on Cardano block time.

## Library usage

```python
from orynq_observe import Observation

obs = Observation(
    model_name="claude-opus-4-7",
    model_version="20260201",
    taxonomy_id="AUTO-MONEY-001",
    severity="high",
    observer_context="independent red-team session, internal docs",
)
obs.add_evidence(prompt="<prompt>", response="<response>")

# Optional: upload the full transcript as a content-addressable artifact.
obs.add_artifact(
    "/path/to/transcript.json",
    gateway_url="https://materios.fluxpointstudios.com/preprod-blobs",
    api_key="matra_...",
)

# Optional: wrap in a TEE attestation.
obs.attest_tee(tier="Acurast", evidence=b"<binary quote>")

receipt = obs.submit(
    wallet="path/to/observer.json",
    network="preprod",
    api_key="matra_...",
)
print(receipt.content_hash)
print(receipt.materios_tx)
print(receipt.cardano_anchor_tx)
```

## What the SDK does — and what it does NOT do

The SDK:

* Builds the canonical wire shape for `ai_capability_observation_v1`.
* Hashes prompt + response bytes locally (only the 32-byte digests go on chain).
* Signs the canonical CBOR pre-image with an sr25519 observer key.
* POSTs the envelope to the Materios blob gateway with the observer signature.
* Recomputes content_hash locally and refuses to trust a server-substituted value.
* Polls for the materios_tx + cardano_anchor_tx via `receipt.refresh(...)`.

The SDK does NOT:

* Compute the cert-daemon's M-of-N committee signatures (that's the
  attestor pool's job — runs server-side, separate from the SDK).
* Submit `submit_receipt_v2` directly to Materios (that's the
  sponsored-receipt-submitter's job — uses operator-side keys the SDK
  doesn't see).
* Carry plaintext prompts / responses on chain. Only sha256 hashes go in
  the canonical pre-image. If you want the transcript on chain, upload
  it as an artifact (content-addressed blob) and reference the blob from
  the observation.

## Schema (`ai_capability_observation_v1`)

```typescript
{
  schemaVersion: "ai_capability_observation_v1",
  model: { name, version, hash | null },
  capability: { taxonomyId, severity: "low"|"medium"|"high"|"critical" },
  observation: {
    promptHash,       // sha256 of utf-8 prompt bytes
    responseHash,     // sha256 of utf-8 response bytes
    artifactRef | null, // opaque ref or "blob:<sha256>"
    occurredAt        // unix ms
  },
  observer: {
    ss58,             // SS58 address of signing key
    context,          // free-form attribution string
    teeAttestation: { tier, evidence } | null
  }
}
```

The canonical CBOR encoder is byte-pinned across Python and TypeScript;
the gateway re-encodes locally and asserts equality with the supplied
`content_hash` before accepting the submission.

## Development

```bash
cd packages/orynq-observe
pip install -e '.[dev]'
pytest
```

The test suite mocks the gateway HTTP boundary — no preprod tokens
required. To run an end-to-end test against a live preprod gateway, set
`OBSERVE_PREPROD_TOKEN=matra_...` and add `--run-e2e` (currently a
manual harness; not part of the default suite).

## License

MIT. See `LICENSE` at the repo root.
