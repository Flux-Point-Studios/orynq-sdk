/**
 * tools/anchor-materios-submit.ts
 *
 * MCP tool: anchor_materios_submit
 *
 * Submits a finalized trace to the Materios partner-chain as a receipt,
 * waits for 2-of-N committee certification, and optionally polls for the
 * eventual Cardano L1 checkpoint anchor. This is the "high-throughput"
 * SDK path (vs anchor_cardano_prepare/submit which skips Materios and
 * writes directly to Cardano under metadata label 2222).
 *
 * Materios → Cardano settlement is automatic via the checkpoint mechanism:
 *   1. submitReceipt(contentHash, rootHash, manifestHash) on Materios
 *   2. Committee cert-daemons sign, reaching the 2-of-N threshold
 *   3. Certificate lands on Materios (cert_hash)
 *   4. Periodically, a Merkle root of certified receipts is anchored to
 *      Cardano via a metadata tx (the "checkpoint"). This tool can block
 *      until the checkpoint for this receipt lands (waitForAnchor).
 *
 * Dependencies:
 *   - MateriosProvider + submitCertifiedReceipt + waitForAnchor from
 *     @fluxpointstudios/orynq-sdk-anchors-materios
 *   - TraceStore (../store.js) for the finalized bundle
 *   - safeTool / toolError (../errors.js)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MateriosProvider,
  submitCertifiedReceipt,
  waitForAnchor,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerAnchorMateriosSubmit(
  server: McpServer,
  store: TraceStore,
  config: Config,
) {
  server.tool(
    "anchor_materios_submit",
    "Submit a finalized trace to the Materios partner-chain as a receipt, wait for committee certification (2-of-N), and optionally wait for the Cardano L1 checkpoint. Materios settles to Cardano automatically via checkpoint — no separate anchor_cardano_* call needed. HIGH — actually submits a tx and spends MOTRA.",
    {
      traceId: z.string().describe("ID of the finalized trace to submit"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Must be true to actually submit. False = dry-run (report what would happen)."
        ),
      waitForL1Anchor: z
        .boolean()
        .default(false)
        .describe(
          "If true, block until the Cardano L1 checkpoint tx lands (can take minutes). If false, return as soon as Materios cert threshold is reached."
        ),
      timeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(1800)
        .default(180)
        .describe(
          "Max time to wait for certification (and L1 anchor if requested). Default 180s."
        ),
    },
    async ({ traceId, confirm, waitForL1Anchor, timeoutSeconds }) => {
      // Trace lookup + finalization check
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);
      if (!entry.bundle) {
        return toolError("Trace not finalized. Call trace_finalize first.");
      }
      const bundle = entry.bundle;

      // Config validation: RPC + signer are always required. Blob gateway auth
      // is optional (gateway may allow public uploads or we use signerKeypair).
      if (!config.materiosRpcUrl) {
        return toolError(
          "MATERIOS_RPC_URL env var not set. Configure it in the MCP server env before calling anchor_materios_submit."
        );
      }
      if (!config.materiosSignerUri) {
        return toolError(
          "MATERIOS_SIGNER_URI env var not set. Provide a mnemonic or derivation path (e.g. //Alice) for the submitter account."
        );
      }
      const blobGatewayUrl =
        config.materiosBlobGatewayUrl ??
        // Sensible preprod default matching the chain spec we're pointed at
        "https://materios.fluxpointstudios.com/preprod-blobs";

      if (!confirm) {
        return safeTool(async () => ({
          traceId,
          status: "dry-run",
          wouldSubmit: {
            rpcUrl: config.materiosRpcUrl,
            // The SDK derives `contentHash` from the JSON content the
            // operator persists to the blob gateway, NOT bundle.rootHash.
            // The real `base_root_sha256` is the chunk-Merkle over those
            // same chunks (computed inside submitCertifiedReceipt), not
            // the trace-bundle's own root. Both are reported as
            // "<derived from blob content>" here so the dry-run isn't
            // misleading.
            contentHash: "<derived from blob content>",
            rootHash: "<derived: chunk-Merkle of upload chunks>",
            manifestHash: "<derived: SHA-256 of manifest JSON>",
            blobGatewayUrl,
            waitForL1Anchor,
            timeoutSeconds,
          },
          note: "Pass confirm:true to actually submit.",
        }));
      }

      return safeTool(async () => {
        const provider = new MateriosProvider({
          rpcUrl: config.materiosRpcUrl!,
          signerUri: config.materiosSignerUri!,
        });
        await provider.connect();
        try {
          // The bundle content itself is what operators persist to the
          // blob gateway. We serialize the public view + manifest — that's
          // the minimum needed for independent verification.
          const content = Buffer.from(
            JSON.stringify({
              publicView: bundle.publicView,
              manifestHash: bundle.manifestHash,
            }),
            "utf-8",
          );

          // Gateway auth: prefer signerKeypair (sr25519-sig-based) over
          // apiKey. Why: sig-based means we don't need a shared secret
          // baked into env vars — any Substrate keypair with MATRA can
          // upload, and the gateway independently verifies the signature
          // against the funded-accounts view. If MATERIOS_BLOB_GATEWAY_API_KEY
          // is set we still honour it (legacy), but the default path is
          // signatures.
          const keypair = provider.getKeypair();
          const signerKeypair = {
            address: keypair.address,
            sign: (data: Uint8Array) => keypair.sign(data),
          };

          const blobGateway: {
            baseUrl: string;
            apiKey?: string;
            signerKeypair?: typeof signerKeypair;
          } = { baseUrl: blobGatewayUrl };
          if (config.materiosBlobGatewayApiKey) {
            blobGateway.apiKey = config.materiosBlobGatewayApiKey;
          } else {
            blobGateway.signerKeypair = signerKeypair;
          }

          // `submitCertifiedReceipt` derives the on-chain hashes from the
          // `content` Buffer:
          //   - `contentHash`        = sha256(content)
          //   - `base_root_sha256`   = chunk-Merkle over upload chunks
          //                            (computed internally; `input.rootHash`
          //                            is IGNORED — kept here for type-shape
          //                            only)
          //   - `manifestHash`       = sha256(manifest JSON), filled by upload
          // The trace-bundle's own rootHash/manifestHash are for trace-bundle
          // audit, not for the receipt's on-chain shape.
          const result = await submitCertifiedReceipt(
            provider,
            {
              contentHash: "",
              rootHash: "",
              manifestHash: "",
            },
            content,
            {
              blobGateway,
              certificationPollOpts: { timeoutMs: timeoutSeconds * 1000 },
              anchorPollOpts: { timeoutMs: timeoutSeconds * 1000 },
            },
          );

          let l1Anchor: unknown = null;
          if (waitForL1Anchor) {
            // Wait for the checkpoint that includes this receipt to land
            // on Cardano. `waitForAnchor` needs a CertificationResult; the
            // result here is CertifiedReceiptResult — lift the fields across.
            if (!result.certHash || !result.leafHash) {
              throw new Error(
                "Cannot wait for L1 anchor: certification did not complete (missing certHash/leafHash)",
              );
            }
            const chainIdHash = await provider
              .getApi()
              .rpc.chain.getBlockHash(0);
            const certResult = {
              receiptId: result.receiptId,
              certHash: result.certHash,
              leafHash: result.leafHash,
              chainId: chainIdHash.toHex(),
            };
            l1Anchor = await waitForAnchor(provider, certResult, {
              timeoutMs: timeoutSeconds * 1000,
            });
          }

          // Cast through unknown — the TraceEntry shape in this codebase
          // doesn't yet declare materios-specific result fields; we attach
          // them as extensions so future reads can see the receipt without
          // a breaking schema change.
          store.set(traceId, {
            ...entry,
            materiosReceipt: result,
            materiosL1Anchor: l1Anchor,
          } as unknown as typeof entry);

          return {
            traceId,
            status: "submitted",
            receiptId: result.receiptId,
            certHash: result.certHash ?? null,
            materiosBlockHash: result.blockHash ?? null,
            l1Anchor,
          };
        } finally {
          await provider.disconnect();
        }
      });
    },
  );
}
