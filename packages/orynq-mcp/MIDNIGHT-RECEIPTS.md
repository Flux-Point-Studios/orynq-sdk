# Hosted Midnight receipt verification

`verify_midnight_receipt` discovers portable batch evidence and verifies its Midnight
execution and finality. Install the optional `@fluxpointstudios/orynq-sdk-anchors-midnight`
package at version 0.3.0 or newer. Version 0.3.2 supplies the signed FPS mainnet author policy.

Configure the read-only sources explicitly on the server:

```text
MIDNIGHT_PROOF_GATEWAY_URL=https://midnight-proofs-a.fluxpointstudios.com
MIDNIGHT_PROOF_RPC_URL=https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc
MIDNIGHT_NETWORK=mainnet
```

Copy B is `https://midnight-proofs-b.fluxpointstudios.com`. Each invocation uses one gateway.
The read RPC is a restricted hosted proxy; the provider token stays on the server. Midnight's
former `rpc.mainnet.midnight.network` endpoint is retired. You may configure your own
credential-free read RPC instead. The hosted proxy needs anchors-midnight 0.3.1 or later.
The two stores share a public tunnel and do not provide independent public availability.
These new variables do not change the existing transaction-hash verifier or wallet endpoints.
No proof-store writer credential, indexer credential or signing key is needed.

Supply all four expected identities from the submitted Materios receipt:

```json
{
  "network": "mainnet",
  "materiosGenesis": "<64 lowercase hex characters>",
  "receiptId": "<64 lowercase hex characters>",
  "contentHash": "<64 lowercase hex characters>",
  "certificateHash": "<64 lowercase hex characters>"
}
```

`contentHash` is the value actually submitted for this receipt. Quickstart trace submission
uses the stored bundle's manifest hash; `anchor_materios_submit` uses its bundle root hash.
Neither convention replaces reading the actual receipt. The certificate hash must match
that receipt's certified fields and certificate format. The tool accepts no endpoint, key
or file path from the model.

Only `status: "valid"` with a consensus-verified anchor establishes the requested receipt's
coverage. The result includes the portable proof. An unresolved result includes diagnostics
and may include a continuation. Pass that exact object back with the same identities,
gateway and policy to perform another bounded invocation. A changed context is refused.
Even `exhaustedHints: true` proves neither absence nor complete coverage.

The CLI exposes the same verifier:

```text
orynq verify midnight-receipt RECEIPT_ID --genesis MATERIOS_GENESIS \
  --content-hash CONTENT_HASH --certificate-hash CERTIFICATE_HASH \
  --gateway https://midnight-proofs-a.fluxpointstudios.com \
  --rpc https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc
```

It prints JSON and exits 0 only for valid evidence. Save the result's `continuation` object
alone to a regular JSON file and pass `--continuation FILE` to resume. Files are limited to
4096 bytes; symlinks and special files are refused. Alternatively configure
`ORYNQ_MIDNIGHT_PROOF_GATEWAY_URL` and `ORYNQ_MIDNIGHT_PROOF_RPC_URL` for these new commands.
No command in this workflow loads a wallet or broadcasts a transaction.
