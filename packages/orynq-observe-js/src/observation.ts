/**
 * Fluent builder for an ai_capability_observation_v1 record.
 *
 *     const obs = new Observation({
 *       modelName: "claude-opus-4-7",
 *       modelVersion: "20260201",
 *       taxonomyId: "AUTO-MONEY-001",
 *       severity: "high",
 *       observerContext: "independent red-team session",
 *     });
 *     obs.addEvidence({ prompt, response });
 *     obs.addArtifact("/path/to/transcript.json");
 *     obs.attestTee({ tier: "Acurast", evidence: "deadbeef" });
 *     const receipt = await obs.submit({ wallet, network: "preprod" });
 *
 * Mirrors the Python builder field-for-field. Builder output is the canonical
 * `AiCapabilityObservationV1` wire shape — hex-string hashes / TEE evidence
 * and ISO 8601 UTC `occurredAt` — so it feeds the schema codec without
 * adaptation.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import {
  type AiCapabilityObservationRecord,
  SCHEMA_VERSION,
  SEVERITIES,
  type Severity,
  TEE_TIERS,
  type TeeTier,
  canonicalContentHash,
} from "./canonical.js";
import { ObserverKeypair } from "./keypair.js";
import {
  type SubmissionReceipt,
  submitObservation,
} from "./submit.js";

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationError";
  }
}

export interface ObservationConstructorOptions {
  modelName: string;
  modelVersion: string;
  taxonomyId: string;
  severity: Severity;
  observerContext: string;
  /** sha256 hex of model weights (64 lowercase hex chars). Null/undefined = unknown. */
  modelHash?: string | null;
  /** ISO 8601 UTC (e.g. "2026-01-15T12:34:56Z"). Defaults to now(). */
  occurredAt?: string;
}

export interface AddEvidenceOptions {
  prompt: string | Uint8Array;
  response: string | Uint8Array;
}

export interface AddEvidenceHashesOptions {
  /** sha256 hex (64 lowercase chars). */
  promptHash: string;
  /** sha256 hex (64 lowercase chars). */
  responseHash: string;
}

export interface AddArtifactOptions {
  pathOrRef: string;
  gatewayUrl?: string;
  apiKey?: string;
}

export interface AttestTeeOptions {
  tier: TeeTier;
  /** Hex string (lowercase, even length). */
  evidence: string;
}

export interface SubmitOptions {
  /** Either a loaded ObserverKeypair OR a filesystem path to a JSON keyfile. */
  wallet: ObserverKeypair | string;
  network?: "preprod" | "mainnet";
  gatewayUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
}

function sha256Hex(b: Uint8Array | string): string {
  if (typeof b === "string") {
    return createHash("sha256").update(b, "utf-8").digest("hex");
  }
  return createHash("sha256").update(b).digest("hex");
}

function nowIso(): string {
  // Millisecond-precision UTC, matches schema's OCCURRED_AT_RE.
  return new Date().toISOString();
}

export class Observation {
  private model: { name: string; version: string; hash: string | null };
  private capability: { taxonomyId: string; severity: Severity };
  private observation: {
    promptHash: string | null;
    responseHash: string | null;
    artifactRef: string | null;
    occurredAt: string;
  };
  private observerContext: string;
  private tee: { tier: TeeTier; evidence: string } | null = null;

  constructor(opts: ObservationConstructorOptions) {
    if (typeof opts.modelName !== "string" || !opts.modelName) {
      throw new ObservationError("modelName must be a non-empty string");
    }
    if (typeof opts.modelVersion !== "string" || !opts.modelVersion) {
      throw new ObservationError("modelVersion must be a non-empty string");
    }
    if (typeof opts.taxonomyId !== "string" || !opts.taxonomyId) {
      throw new ObservationError("taxonomyId must be a non-empty string");
    }
    if (!SEVERITIES.includes(opts.severity)) {
      throw new ObservationError(
        `severity must be one of ${SEVERITIES.join(",")}, got ${opts.severity}`,
      );
    }
    if (typeof opts.observerContext !== "string") {
      throw new ObservationError("observerContext must be a string");
    }
    if (opts.occurredAt !== undefined && typeof opts.occurredAt !== "string") {
      throw new ObservationError("occurredAt must be an ISO 8601 UTC string");
    }
    this.model = {
      name: opts.modelName,
      version: opts.modelVersion,
      hash: opts.modelHash ?? null,
    };
    this.capability = {
      taxonomyId: opts.taxonomyId,
      severity: opts.severity,
    };
    this.observation = {
      promptHash: null,
      responseHash: null,
      artifactRef: null,
      occurredAt: opts.occurredAt ?? nowIso(),
    };
    this.observerContext = opts.observerContext;
  }

  addEvidence(opts: AddEvidenceOptions): Observation {
    const promptBytes =
      typeof opts.prompt === "string"
        ? new TextEncoder().encode(opts.prompt)
        : opts.prompt;
    const responseBytes =
      typeof opts.response === "string"
        ? new TextEncoder().encode(opts.response)
        : opts.response;
    this.observation.promptHash = sha256Hex(promptBytes);
    this.observation.responseHash = sha256Hex(responseBytes);
    return this;
  }

  addEvidenceHashes(opts: AddEvidenceHashesOptions): Observation {
    this.observation.promptHash = opts.promptHash;
    this.observation.responseHash = opts.responseHash;
    return this;
  }

  /**
   * Two modes:
   *   - First argument is an existing file path AND `gatewayUrl` is set:
   *     uploads the bytes to the blob-gateway and sets
   *     `artifactRef = "blob:<sha256_hex>"`.
   *   - Otherwise: treats input as an opaque ref (IPFS CID, S3 URL, hash hex)
   *     and stores verbatim.
   *
   * Accepts either an options object or a positional path-or-ref string for
   * ergonomic call-site shapes — mirrors the Python `add_artifact()`.
   */
  async addArtifact(
    pathOrRefOrOpts: string | AddArtifactOptions,
    extra?: { gatewayUrl?: string; apiKey?: string },
  ): Promise<Observation> {
    const opts: AddArtifactOptions =
      typeof pathOrRefOrOpts === "string"
        ? {
            pathOrRef: pathOrRefOrOpts,
            gatewayUrl: extra?.gatewayUrl,
            apiKey: extra?.apiKey,
          }
        : pathOrRefOrOpts;
    if (typeof opts.pathOrRef !== "string" || !opts.pathOrRef) {
      throw new ObservationError("pathOrRef must be a non-empty string");
    }
    if (opts.gatewayUrl && this.isExistingFile(opts.pathOrRef)) {
      const ref = await this.uploadArtifact(
        opts.pathOrRef,
        opts.gatewayUrl,
        opts.apiKey,
      );
      this.observation.artifactRef = ref;
    } else {
      this.observation.artifactRef = opts.pathOrRef;
    }
    return this;
  }

  attestTee(opts: AttestTeeOptions): Observation {
    if (!(TEE_TIERS as readonly string[]).includes(opts.tier)) {
      throw new ObservationError(
        `tier must be one of ${TEE_TIERS.join(",")}, got ${opts.tier}`,
      );
    }
    if (typeof opts.evidence !== "string" || opts.evidence.length === 0) {
      throw new ObservationError(
        "evidence must be a non-empty hex string",
      );
    }
    this.tee = { tier: opts.tier, evidence: opts.evidence };
    return this;
  }

  toRecord(observerSs58: string): AiCapabilityObservationRecord {
    if (!this.observation.promptHash || !this.observation.responseHash) {
      throw new ObservationError(
        "promptHash + responseHash are required — call addEvidence(...) " +
          "or addEvidenceHashes(...) before submit()",
      );
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      model: { ...this.model },
      capability: { ...this.capability },
      observation: {
        promptHash: this.observation.promptHash,
        responseHash: this.observation.responseHash,
        artifactRef: this.observation.artifactRef,
        occurredAt: this.observation.occurredAt,
      },
      observer: {
        ss58: observerSs58,
        context: this.observerContext,
        teeAttestation: this.tee ? { ...this.tee } : null,
      },
    };
  }

  contentHash(observerSs58: string): string {
    return canonicalContentHash(this.toRecord(observerSs58));
  }

  async submit(opts: SubmitOptions): Promise<SubmissionReceipt> {
    let kp: ObserverKeypair;
    if (opts.wallet instanceof ObserverKeypair) {
      kp = opts.wallet;
    } else if (typeof opts.wallet === "string") {
      kp = await ObserverKeypair.load(opts.wallet);
    } else {
      throw new ObservationError(
        "wallet must be ObserverKeypair or keyfile path",
      );
    }
    const record = this.toRecord(kp.ss58Address);
    return submitObservation({
      record,
      keypair: kp,
      network: opts.network ?? "preprod",
      gatewayUrl: opts.gatewayUrl,
      apiKey: opts.apiKey,
      timeoutSeconds: opts.timeoutSeconds,
    });
  }

  // ---------------- helpers ----------------

  private isExistingFile(path: string): boolean {
    try {
      const s = statSync(path);
      return s.isFile();
    } catch {
      return false;
    }
  }

  private async uploadArtifact(
    path: string,
    gatewayUrl: string,
    apiKey: string | undefined,
  ): Promise<string> {
    const payload = readFileSync(path);
    const digest = sha256Hex(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
    const base = gatewayUrl.replace(/\/+$/, "");
    const url = `${base}/blobs`;
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "user-agent": "orynq-observe-js/0.1.0",
    };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
    });
    if (!(resp.status >= 200 && resp.status < 300)) {
      const text = await resp.text();
      throw new ObservationError(
        `artifact upload failed: status=${resp.status} body=${text.slice(0, 200)}`,
      );
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const serverHash =
      (body?.content_hash as string | undefined) ??
      (body?.contentHash as string | undefined) ??
      (body?.sha256 as string | undefined);
    if (serverHash && serverHash.toLowerCase() !== digest.toLowerCase()) {
      throw new ObservationError(
        `gateway returned a content_hash that does not match the SDK-computed sha256 (SDK=${digest}, server=${serverHash})`,
      );
    }
    return `blob:${digest}`;
  }
}
