"""Helpers for the Phase 2 (Wave 3) Path C smoke harness.

Path C ships the Wave 3 Phase 2 demo without a live phone: it submits a
`compute_metering_v2.1` record carrying ONE `arm_trustzone` evidence entry
whose payload contains a REAL Google-rooted Pixel StrongBox attestation
chain, vendored verbatim from `pallets/tee-attestation/src/test_vectors.rs`
(itself imported from Acurast/acurast-substrate). The pallet's
`ArmTrustZoneVerifier` validates the chain end-to-end (Google root →
intermediates → leaf), proving the same hardware-attestation primitive
that protects production Acurast workloads is live on Materios preprod.

Two trust layers, kept independent in the demo's design:

  1. **Cert-chain layer (the chain-of-trust check on chain).**
     The cert chain in the evidence payload is REAL — pulled from the
     Acurast test vectors which themselves came from production Pixel
     StrongBox / Samsung TEE devices. The pallet's verifier walks
     Google Root → intermediates → leaf, verifying every signature.
     This is what the demo proves: Materios accepts real Google-rooted
     Android Key Attestation chains.

  2. **Attestor-signature layer (the gateway's `/v2/attestation_evidence`
     endpoint).**
     The endpoint requires a `signature` over canonical CBOR of the
     payload. The signing key is the attestor's sr25519 keypair, NOT
     the cert chain's leaf private key (we don't have that — it's in
     the real device's TEE). For the demo we generate a fresh sr25519
     keypair, register its pubkey via `/admin/attestation-evidence-attestors`,
     and sign the payload with it. The cert chain inside the payload is
     untouched — the on-chain pallet verifies it independently.

These layers are deliberately separate concerns:

   * Layer 1 = "this evidence was produced inside Google-rooted hardware"
   * Layer 2 = "this attestor agrees this evidence belongs to this receipt"

A real-phone deployment (queued behind Acurast onboarding) collapses
the two layers into one signing key inside the phone's TEE — but the
demo proves Layer 1 today on the data plane that Layer 2 will use
unchanged.
"""
from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import httpx

# v2.1 canonical helpers — re-used so the harness shares one source of truth
# with the SDK's encoder, the cross-language test, and the gateway's TS code.
from materios_compute_meter.canonical import (
    canonical_cbor_for_evidence_payload,
    derive_evidence_nonce,
)
from materios_compute_meter.keypair import WorkerKeypair


# ---------------------------------------------------------------------------
# Real-device test vectors. Source-of-truth lives in
# `materios-task180/partnerchain/pallets/tee-attestation/src/test_vectors.rs`
# (which itself vendors them from Acurast/acurast-substrate@d205a7d3).
#
# We mirror them here as Python constants so the smoke harness has no
# build-time coupling to the pallet crate. If the pallet's vectors change,
# regenerate this module's constants from the .rs file and re-pin.
# ---------------------------------------------------------------------------

# --- Pixel chain (Google Pixel StrongBox / Titan-M chip). Index 0 is root,
# ascending toward leaf. The pallet's verifier accepts the chain in
# root → leaf order.

PIXEL_ROOT_CERT_B64 = (
    "MIIFYDCCA0igAwIBAgIJAOj6GWMU0voYMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMTYwNTI2MTYyODUyWhcNMjYwNTI0MTYyODUyWjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5UmAGMCAwEAAaOBpjCBozAdBgNVHQ4EFgQUNmHhAHyIBQlRi0RsR/8aTMnqTxIwHwYDVR0jBBgwFoAUNmHhAHyIBQlRi0RsR/8aTMnqTxIwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwQAYDVR0fBDkwNzA1oDOgMYYvaHR0cHM6Ly9hbmRyb2lkLmdvb2dsZWFwaXMuY29tL2F0dGVzdGF0aW9uL2NybC8wDQYJKoZIhvcNAQELBQADggIBACDIw41L3KlXG0aMiS//cqrG+EShHUGo8HNsw30W1kJtjn6UBwRM6jnmiwfBPb8VA91chb2vssAtX2zbTvqBJ9+LBPGCdw/E53Rbf86qhxKaiAHOjpvAy5Y3m00mqC0w/Zwvju1twb4vhLaJ5NkUJYsUS7rmJKHHBnETLi8GFqiEsqTWpG/6ibYCv7rYDBJDcR9W62BW9jfIoBQcxUCUJouMPH25lLNcDc1ssqvC2v7iUgI9LeoM1sNovqPmQUiG9rHli1vXxzCyaMTjwftkJLkf6724DFhuKug2jITV0QkXvaJWF4nUaHOTNA4uJU9WDvZLI1j83A+/xnAJUucIv/zGJ1AMH2boHqF8CY16LpsYgBt6tKxxWH00XcyDCdW2KlBCeqbQPcsFmWyWugxdcekhYsAWyoSf818NUsZdBWBaR/OukXrNLfkQ79IyZohZbvabO/X+MVT3rriAoKc8oE2Uws6DF+60PV7/WIPjNvXySdqspImSN78mflxDqwLqRBYkA3I75qppLGG9rp7UCdRjxMl8ZDBld+7yvHVgt1cVzJx9xnyGCC23UaicMDSXYrB4I4WHXPGjxhZuCuPBLTdOLU8YRvMYdEvYebWHMpvwGCF6bAx3JBpIeOQ1wDB5y0USicV3YgYGmi+NZfhA4URSh77Yd6uuJOJENRaNVTzk"
)

PIXEL_INTERMEDIATE_2_CERT_B64 = (
    "MIID1zCCAb+gAwIBAgIKA4gmZ2BliZaF9TANBgkqhkiG9w0BAQsFADAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MB4XDTE5MDgwOTIzMDMyM1oXDTI5MDgwNjIzMDMyM1owLzEZMBcGA1UEBRMQNTRmNTkzNzA1NDJmNWE5NTESMBAGA1UEDAwJU3Ryb25nQm94MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE41Inb5v86kMBpfBCf6ZHjlcyCa5E/XYs+8V8u9RxNjFQnoAuoOlAU25U+iVwyihGFUaYB1UJKTsxALOVW0MXdosoa/b+JlHFmvbGsNszYAkKRkfHhg527MO4p9tc5XrMo4G2MIGzMB0GA1UdDgQWBBRpkLEMOwiK7ir4jDOHtCwS2t/DpjAfBgNVHSMEGDAWgBQ2YeEAfIgFCVGLRGxH/xpMyepPEjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDBQBgNVHR8ESTBHMEWgQ6BBhj9odHRwczovL2FuZHJvaWQuZ29vZ2xlYXBpcy5jb20vYXR0ZXN0YXRpb24vY3JsLzhGNjczNEM5RkE1MDQ3ODkwDQYJKoZIhvcNAQELBQADggIBAFxZEyegsCSeytyUkYTJZR7R8qYXoXUWQ5h1Qp6b0h+H/SNl0NzedHAiwZQQ8jqzgP4c7w9HrrxEPCpFMd8+ykEBv5bWvDDf2HjtZzRlMRG154KgM1DMJgXhKLSKV+f/H+S/QQTeP3yprOavsBvdkgX6ELkYN6M3JXr7gpCvpFb6Ypz65Ud7FysAm/KNQ9zU0x7cvz3Btvz8ylw4p5dz04tanTzNgVLVHyX5kAcB2ftPvxMH4X/PXdx1lAmGPS8PsubCRGjJxdhRVOEEMYyxCuYLonuyUggOByZFaBw55WDoWGpkVQhnFi9L3p23VkWILLnq/07+GwoxL1vUAiQpjJHxNQYbjgTo+kxhjDP3uULAKPANGBE7+25VqVLMtdce4Eb5v9yFqgg+JtlL41RUWVS3DIEqxOMm/fB3A7t55TbUKf8dCZyBci2BcUWTx8K7VnQMy8gBMyu1SGleKPLIrBRSomDP5X8xGtwTLo3aAdY4+aSjEoimI6kX9bbIfhyDFpJxKaDRHzhCUdLfJrlCp2hEq5GWj0lT50hPLs0tbhh/l3LTtFhKyYbiB5vHXyB3P4gUui0WxyZnYdajUF+Tn8MW79qHhwhaXU9HnflE+dBh0smazOc+0xdwZZKXET+UFAUAMGiHvhuICCuWsY4SPKv8/715toeCoECHSMv08C9C"
)

PIXEL_INTERMEDIATE_1_CERT_B64 = (
    "MIICMDCCAbegAwIBAgIKFZBYV0ZxdmNYNDAKBggqhkjOPQQDAjAvMRkwFwYDVQQFExA1NGY1OTM3MDU0MmY1YTk1MRIwEAYDVQQMDAlTdHJvbmdCb3gwHhcNMTkwNzI3MDE1MjE5WhcNMjkwNzI0MDE1MjE5WjAvMRkwFwYDVQQFExA5NzM1Mzc3OTM2ZDBkZDc0MRIwEAYDVQQMDAlTdHJvbmdCb3gwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR2OZY6u30za18jjYs1Xv2zlaIrLM3me9okMo5Lv4Av76l/IE3YvbRQMyy15Wb3Wb3G/6+587x443R9/Ognjl8Co4G6MIG3MB0GA1UdDgQWBBRBPjyps0vHpRy7ASXAQhvmUa162DAfBgNVHSMEGDAWgBRpkLEMOwiK7ir4jDOHtCwS2t/DpjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDBUBgNVHR8ETTBLMEmgR6BFhkNodHRwczovL2FuZHJvaWQuZ29vZ2xlYXBpcy5jb20vYXR0ZXN0YXRpb24vY3JsLzE1OTA1ODU3NDY3MTc2NjM1ODM0MAoGCCqGSM49BAMCA2cAMGQCMBeg3ziAoi6h1LPfvbbASk5WVdC6cL3IpaxIOycMHm1SDNqYALOtd1uujfzMeobs+AIwKJj5XySGe7MRL0QNtdrSd2nkK+fbjcUc8LKvVapDwRAC40CiTzllAy+aOnyDxrvb"
)

PIXEL_KEY_CERT_B64 = (
    "MIICnDCCAkGgAwIBAgIBATAMBggqhkjOPQQDAgUAMC8xGTAXBgNVBAUTEDk3MzUzNzc5MzZkMGRkNzQxEjAQBgNVBAwMCVN0cm9uZ0JveDAiGA8yMDIyMDcwOTEwNTE1NVoYDzIwMjgwNTIzMjM1OTU5WjAfMR0wGwYDVQQDDBRBbmRyb2lkIEtleXN0b3JlIEtleTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABLIMHRVHdmJiPs9DAQSJgAbg+BwNsbrofLlqh8d3dARlnlhdPZBXuKL/iuYfQBoHj8dc9SyMQmjoEPk3mMcp6GKjggFWMIIBUjAOBgNVHQ8BAf8EBAMCB4AwggE+BgorBgEEAdZ5AgERBIIBLjCCASoCAQQKAQICASkKAQIECHRlc3Rhc2RmBAAwbL+FPQgCBgGB4pZhH7+FRVwEWjBYMTIwMAQrY29tLnViaW5ldGljLmF0dGVzdGVkLmV4ZWN1dG9yLnRlc3QudGVzdG5ldAIBDjEiBCC9y0Vg9rPEHa2SBmgWnCi+HvnqSfI9mM2OsvN65EiP+TCBoaEFMQMCAQKiAwIBA6MEAgIBAKUFMQMCAQCqAwIBAb+DdwIFAL+FPgMCAQC/hUBMMEoEIIec0/GOp24kTU1Kw7y5wzfBO0ZnGQsZA1r+JTZVAFDxAQH/CgEABCA/QTbuNYHmq6jqM3prQ9cD3h7KJB+bfyd+zfr/96jc8b+FQQUCAwHUwL+FQgUCAwMV3r+FTgYCBAE0ir2/hU8GAgQBNIq9MAwGCCqGSM49BAMCBQADRwAwRAIgM6YTzOmm7SUCakkrZR8Kxnw8AonU5HQxaMaQPi+qC9oCIDJM01xL8mldca0Sooho5pIyESki6vDjaZ9q3YEz1SjZ"
)

# Tampered leaf (last byte of signature flipped Z->Y). Used by the negative
# test: the cert-daemon must REFUSE to attest. The chain still parses and
# the gateway will still STORE the evidence — the rejection is a chain-side
# property of the pallet's verifier.
PIXEL_KEY_CERT_INVALID_B64 = (
    "MIICnDCCAkGgAwIBAgIBATAMBggqhkjOPQQDAgUAMC8xGTAXBgNVBAUTEDk3MzUzNzc5MzZkMGRkNzQxEjAQBgNVBAwMCVN0cm9uZ0JveDAiGA8yMDIyMDcwOTEwNTE1NVoYDzIwMjgwNTIzMjM1OTU5WjAfMR0wGwYDVQQDDBRBbmRyb2lkIEtleXN0b3JlIEtleTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABLIMHRVHdmJiPs9DAQSJgAbg+BwNsbrofLlqh8d3dARlnlhdPZBXuKL/iuYfQBoHj8dc9SyMQmjoEPk3mMcp6GKjggFWMIIBUjAOBgNVHQ8BAf8EBAMCB4AwggE+BgorBgEEAdZ5AgERBIIBLjCCASoCAQQKAQICASkKAQIECHRlc3Rhc2RmBAAwbL+FPQgCBgGB4pZhH7+FRVwEWjBYMTIwMAQrY29tLnViaW5ldGljLmF0dGVzdGVkLmV4ZWN1dG9yLnRlc3QudGVzdG5ldAIBDjEiBCC9y0Vg9rPEHa2SBmgWnCi+HvnqSfI9mM2OsvN65EiP+TCBoaEFMQMCAQKiAwIBA6MEAgIBAKUFMQMCAQCqAwIBAb+DdwIFAL+FPgMCAQC/hUBMMEoEIIec0/GOp24kTU1Kw7y5wzfBO0ZnGQsZA1r+JTZVAFDxAQH/CgEABCA/QTbuNYHmq6jqM3prQ9cD3h7KJB+bfyd+zfr/96jc8b+FQQUCAwHUwL+FQgUCAwMV3r+FTgYCBAE0ir2/hU8GAgQBNIq9MAwGCCqGSM49BAMCBQADRwAwRAIgM6YTzOmm7SUCakkrZR8Kxnw8AonU5HQxaMaQPi+qC9oCIDJM01xL8mldca0Sooho5pIyESki6vDjaZ9q3YAz1SjZ"
)


def pixel_chain_b64(*, valid: bool = True) -> List[str]:
    """Return the Pixel StrongBox cert chain as a list of base64 strings.

    Order matches what the pallet's verifier accepts: index 0 = Google root,
    last entry = leaf. When ``valid=False`` the leaf is the tampered cert
    `PIXEL_KEY_CERT_INVALID` — used by the negative attestation test.
    """
    return [
        PIXEL_ROOT_CERT_B64,
        PIXEL_INTERMEDIATE_2_CERT_B64,
        PIXEL_INTERMEDIATE_1_CERT_B64,
        (PIXEL_KEY_CERT_B64 if valid else PIXEL_KEY_CERT_INVALID_B64),
    ]


# Samsung TEE chain — kept here as a comment-pointer for the multi-vendor
# follow-up. The harness uses Pixel as the canonical demo; flipping to
# Samsung means swapping `pixel_chain_b64()` for `samsung_chain_b64()` and
# regenerating the SPKI sha256 for the registered attestor key. The Samsung
# vectors are present in
# `pallets/tee-attestation/src/test_vectors.rs` (constants `SAMSUNG_*`)
# and can be lifted in a follow-up commit when we want a Pixel-vs-Samsung
# parity smoke.


# ---------------------------------------------------------------------------
# Minimal ASN.1 DER walker — extracts a leaf cert's SubjectPublicKeyInfo
# bytes so we can compute the pallet's `attest_key_hash`.
#
# The pallet's ARM verifier sets `attest_key_hash = sha256(SPKI_DER)` for
# every successfully-validated leaf. We mirror that derivation in Python so
# the smoke harness can emit the same hash value as the on-chain pallet —
# critical for the round-trip assertions in the Cardano-anchor test.
#
# The standard `cryptography` library would give us this in two lines, but
# it's not in compute-meter-sdk's existing pyproject.toml deps. The walk
# below is ~30 lines and uses only the stdlib — see the per-byte annotations
# inline. If we ever pick up `cryptography` for a different reason, this
# walker can be deleted and replaced with `x509.load_der_x509_certificate`.
# ---------------------------------------------------------------------------


def _parse_der_tlv(buf: bytes, off: int) -> Tuple[int, int, int, int]:
    """Parse one ASN.1 DER TLV at ``buf[off:]``.

    Returns ``(tag, length, content_offset, total_consumed)``. The total
    consumed is the number of bytes the TLV occupies as a whole — i.e.
    ``buf[off:off+total_consumed]`` is the raw TLV.
    """
    tag = buf[off]
    pos = off + 1
    first = buf[pos]
    if first & 0x80:
        # Long-form length: low 7 bits = number of length bytes that follow.
        nlen = first & 0x7F
        length = int.from_bytes(buf[pos + 1 : pos + 1 + nlen], "big")
        content_off = pos + 1 + nlen
    else:
        length = first
        content_off = pos + 1
    total = (content_off + length) - off
    return tag, length, content_off, total


def extract_leaf_spki_der(leaf_cert_der: bytes) -> bytes:
    """Return the SubjectPublicKeyInfo SEQUENCE bytes (with its outer
    `0x30 <len> ...` wrapper) from a DER-encoded X.509 certificate.

    The pallet computes ``attest_key_hash = sha256(SPKI_DER)`` over exactly
    these bytes; mirror the derivation here. Implementation walks:

        Certificate ::= SEQUENCE {
            tbsCertificate    TBSCertificate,
            signatureAlgorithm AlgorithmIdentifier,
            signatureValue    BIT STRING
        }
        TBSCertificate ::= SEQUENCE {
            version              [0] EXPLICIT INTEGER DEFAULT v1,
            serialNumber         INTEGER,
            signature            AlgorithmIdentifier,
            issuer               Name,
            validity             Validity,
            subject              Name,
            subjectPublicKeyInfo SubjectPublicKeyInfo,    -- target
            ...
        }
    """
    # Outer Certificate SEQUENCE
    tag, _, content_off, _ = _parse_der_tlv(leaf_cert_der, 0)
    if tag != 0x30:
        raise ValueError("leaf cert: outer tag is not SEQUENCE")
    # TBSCertificate SEQUENCE
    tbs_off = content_off
    tag2, l2, content_off2, _ = _parse_der_tlv(leaf_cert_der, tbs_off)
    if tag2 != 0x30:
        raise ValueError("leaf cert: TBS tag is not SEQUENCE")
    end_tbs = content_off2 + l2
    ptr = content_off2

    # Optional [0] EXPLICIT version tag — context-specific, constructed.
    if leaf_cert_der[ptr] == 0xA0:
        _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
        ptr += c
    # serialNumber (INTEGER)
    _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
    ptr += c
    # signature AlgorithmIdentifier
    _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
    ptr += c
    # issuer
    _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
    ptr += c
    # validity
    _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
    ptr += c
    # subject
    _, _, _, c = _parse_der_tlv(leaf_cert_der, ptr)
    ptr += c
    # subjectPublicKeyInfo — the prize.
    if ptr >= end_tbs:
        raise ValueError("leaf cert: walked past TBS without finding SPKI")
    spki_start = ptr
    tag_spki, _, _, c_spki = _parse_der_tlv(leaf_cert_der, ptr)
    if tag_spki != 0x30:
        raise ValueError("leaf cert: SPKI tag is not SEQUENCE")
    return leaf_cert_der[spki_start : spki_start + c_spki]


def pixel_leaf_spki_sha256() -> str:
    """SHA-256 hex of the Pixel leaf cert's SPKI bytes.

    This is the value the pallet stores as `attest_key_hash` once it has
    successfully verified the chain. Useful to log in the smoke output so a
    human reviewing the demo can grep for it on chain.
    """
    leaf_der = base64.b64decode(PIXEL_KEY_CERT_B64)
    spki = extract_leaf_spki_der(leaf_der)
    return hashlib.sha256(spki).hexdigest()


# ---------------------------------------------------------------------------
# Synthetic sr25519 attestor — the Layer 2 key (see module docstring).
#
# Generated fresh per session OR loaded from a stable file (set the env var
# below to point at a JSON file that `WorkerKeypair` understands). Keeping
# the key stable across sessions lets the operator register the pubkey ONCE
# via `/admin/attestation-evidence-attestors` and then re-run the harness
# repeatedly without re-registering.
# ---------------------------------------------------------------------------


def load_or_generate_synthetic_attestor() -> WorkerKeypair:
    """Return the synthetic sr25519 keypair used for evidence-endpoint sigs.

    If `PHASE2_ATTESTOR_KEY` is set and points at an existing file, load it.
    Otherwise generate a fresh keypair (its pubkey will need re-registering
    each session — fine for one-shot smokes; set the env var for long runs).
    """
    path = os.environ.get("PHASE2_ATTESTOR_KEY", "").strip()
    if path and os.path.isfile(path):
        return WorkerKeypair.load(path)
    return WorkerKeypair.generate()


# ---------------------------------------------------------------------------
# Evidence-payload builder. Mirrors the canonical wire shape the gateway's
# CBOR encoder + the pallet's verifier both expect:
#
#   { "cert_chain_b64": [<root>, <int>, ..., <leaf>] }
#
# Binary keys end in `_b64` per the gateway's pinned convention (see
# `services/blob-gateway/src/schemas/compute_metering_v2.ts §
# attestation_evidence — payload encoding`). The base64 strings are
# canonical-CBOR-decoded into raw bytes by the encoder before signing.
#
# Note: the pallet's `ArmTrustZoneVerifier` SCALE-decodes the payload's
# bytes-list as `Vec<Vec<u8>>` (chain entries). The gateway encodes the
# same chain as a CBOR array of byte-strings. The cert-daemon is the layer
# that translates the CBOR-array shape into the SCALE-array shape it
# submits on chain — so the wire shapes don't have to match byte-for-byte.
# What we need to keep stable is the LIST of cert DER bytes; that's what
# this helper hands the gateway.
# ---------------------------------------------------------------------------


def build_arm_trustzone_payload(*, valid: bool = True) -> Dict[str, object]:
    """Return the canonical evidence payload for an `arm_trustzone` entry.

    Shape:
        {
            "cert_chain_b64": [<root>, <int1>, <int2>, <leaf>],
            "device_model": "Pixel-strongbox-test-vector",
            "security_level": "StrongBox",
        }

    The non-binary keys are metadata only — the pallet's verifier reads the
    leaf cert's parsed `KeyDescription` for the actual security level. The
    `device_model` / `security_level` strings are echoed in audit logs.
    """
    return {
        "cert_chain_b64": pixel_chain_b64(valid=valid),
        "device_model": "Pixel-strongbox-test-vector",
        "security_level": "StrongBox",
    }


@dataclass(frozen=True)
class SignedEvidence:
    """Bundle ready to POST to `/v2/attestation_evidence`.

    Attributes:
        receipt_id: 64-hex receipt_id derived from content_hash.
        evidence_type: "arm_trustzone".
        nonce: sha256(content_hash || utf8(evidence_type)) — 64 hex.
        payload: JSON-shaped payload dict (CBOR-canonicalised by the gateway).
        attestor_pubkey: 64 hex of the synthetic sr25519 attestor.
        signature: 128 hex sr25519 sig over canonical-CBOR(payload).
    """

    receipt_id: str
    evidence_type: str
    nonce: str
    payload: Dict[str, object]
    attestor_pubkey: str
    signature: str

    def to_wire(self) -> Dict[str, object]:
        """Wire-format dict to JSON-encode for the POST body."""
        return {
            "receipt_id": self.receipt_id,
            "evidence_type": self.evidence_type,
            "nonce": self.nonce,
            "payload": self.payload,
            "attestor_pubkey": self.attestor_pubkey,
            "signature": self.signature,
        }


def derive_receipt_id(content_hash_hex: str) -> str:
    """Mirror of `services/blob-gateway/src/storage.ts::computeReceiptId`.

    `receipt_id = sha256(content_hash_bytes)`. Returns 64 lowercase hex,
    no `0x` prefix (the wire schema accepts both forms; we emit the
    no-prefix form for byte-stable comparison with /admin endpoints).
    """
    cleaned = content_hash_hex[2:] if content_hash_hex.startswith("0x") else content_hash_hex
    return hashlib.sha256(bytes.fromhex(cleaned)).hexdigest()


def sign_evidence(
    *,
    content_hash_hex: str,
    payload: Dict[str, object],
    attestor: WorkerKeypair,
    evidence_type: str = "arm_trustzone",
) -> SignedEvidence:
    """Build + sign an evidence bundle ready for `/v2/attestation_evidence`.

    The gateway expects the signature over the canonical CBOR of the
    PAYLOAD only (NOT the full evidence map). We re-use the SDK's pinned
    encoder (`canonical_cbor_for_evidence_payload`) so byte equality with
    the gateway's verifier is a byte-for-byte property test.
    """
    nonce = derive_evidence_nonce(content_hash_hex, evidence_type)
    payload_bytes = canonical_cbor_for_evidence_payload(payload)
    sig = attestor.sign_bytes(payload_bytes)
    return SignedEvidence(
        receipt_id=derive_receipt_id(content_hash_hex),
        evidence_type=evidence_type,
        nonce=nonce,
        payload=payload,
        attestor_pubkey=attestor.public_hex,
        signature=sig.hex(),
    )


# ---------------------------------------------------------------------------
# Gateway client — register attestor + post evidence.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GatewayConfig:
    base_url: str
    bearer: str  # tenant-bound matra_* token (used by /metering/submit)
    admin_token: Optional[str]  # admin shared secret (used by /admin/*)


def gateway_evidence_endpoint_present(
    base_url: str, *, timeout_s: float = 5.0
) -> Optional[bool]:
    """Probe whether the gateway exposes the v2.1 evidence endpoint.

    Returns True if the route exists (any 4xx response other than 404),
    False if the gateway returns 404, None on transport error.
    Used by the prereq check; if the gateway image is the OLD one, all
    Phase 2 tests skip with a clear message.
    """
    url = f"{base_url.rstrip('/')}/v2/attestation_evidence"
    try:
        with httpx.Client(timeout=timeout_s) as c:
            r = c.post(url, json={"probe": True})
        if r.status_code == 404:
            return False
        return True
    except httpx.HTTPError:
        return None


def gateway_admin_attestor_endpoint_present(
    base_url: str, *, admin_token: str, timeout_s: float = 5.0
) -> Optional[bool]:
    """Probe whether the admin-attestor registry route is deployed.

    Sends a HEAD to GET /admin/attestation-evidence-attestors. 404 = not
    deployed. 401/403/200/503 = deployed (gateway answered).
    """
    url = f"{base_url.rstrip('/')}/admin/attestation-evidence-attestors"
    try:
        with httpx.Client(timeout=timeout_s) as c:
            r = c.get(url, headers={"x-admin-token": admin_token})
        if r.status_code == 404:
            return False
        return True
    except httpx.HTTPError:
        return None


def register_attestor(
    cfg: GatewayConfig,
    *,
    pubkey_hex: str,
    label: str,
    notes: str,
    timeout_s: float = 10.0,
) -> Dict[str, object]:
    """POST `/admin/attestation-evidence-attestors`. Idempotent: a 409
    response (already-registered) is treated as success and the existing
    row is returned. Any other non-2xx status raises.
    """
    if not cfg.admin_token:
        raise RuntimeError("admin_token missing from GatewayConfig")
    url = f"{cfg.base_url.rstrip('/')}/admin/attestation-evidence-attestors"
    body = {"pubkey": pubkey_hex, "label": label, "notes": notes}
    headers = {"x-admin-token": cfg.admin_token, "content-type": "application/json"}
    with httpx.Client(timeout=timeout_s) as c:
        r = c.post(url, json=body, headers=headers)
    if r.status_code in (200, 201):
        return r.json()
    if r.status_code == 409:
        # Already registered — return the existing row's JSON.
        return r.json()
    raise RuntimeError(
        f"register_attestor: gateway returned {r.status_code} {r.text[:200]!r}"
    )


def post_evidence(
    cfg: GatewayConfig,
    bundle: SignedEvidence,
    *,
    timeout_s: float = 15.0,
) -> Tuple[int, Dict[str, object]]:
    """POST a signed evidence bundle to `/v2/attestation_evidence`.

    Returns ``(status_code, decoded_json_body)``. Tests assert on both.
    """
    url = f"{cfg.base_url.rstrip('/')}/v2/attestation_evidence"
    headers = {
        "authorization": f"Bearer {cfg.bearer}",
        "content-type": "application/json",
        "user-agent": "materios-compute-meter-phase2-smoke/0.1",
    }
    with httpx.Client(timeout=timeout_s) as c:
        r = c.post(url, json=bundle.to_wire(), headers=headers)
    try:
        body = r.json()
    except Exception:
        body = {"_raw": r.text}
    return r.status_code, body


# ---------------------------------------------------------------------------
# Substrate prereq probe — confirms the pallet-tee-attestation runtime
# upgrade has landed AND the kill-switch is flipped.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PalletReadiness:
    metadata_present: bool   # True if `TeeAttestation` pallet is in metadata
    disabled: Optional[bool]  # None if storage missing; bool when readable

    @property
    def fully_ready(self) -> bool:
        return self.metadata_present and self.disabled is False


def probe_pallet_tee_attestation(
    rpc_url: str, *, pallet_name: str = "TeeAttestation", timeout_s: float = 10.0
) -> Optional[PalletReadiness]:
    """Connect to the Materios substrate RPC and inspect the runtime metadata.

    Returns a `PalletReadiness` with two booleans, OR None if the RPC is
    unreachable. The kill-switch storage is `Disabled: bool` per PR #17.
    """
    try:
        # Local import — substrate-interface drags scalecodec at module-load,
        # and we want the import error to show up in this helper rather than
        # at test-collection time on hosts without the dep.
        from substrateinterface import SubstrateInterface  # noqa: WPS433
    except Exception:
        return None
    try:
        si = SubstrateInterface(url=rpc_url, ws_options={"timeout": timeout_s})
    except Exception:
        return None
    try:
        metadata = si.metadata
        names = [
            getattr(p, "name", None) or p.value.get("name")
            for p in metadata.pallets
        ]
        present = pallet_name in names
        disabled: Optional[bool] = None
        if present:
            try:
                v = si.query(pallet_name, "Disabled")
                # `v` is a ScaleType wrapping a bool. `v.value` is the python bool.
                disabled = bool(getattr(v, "value", v))
            except Exception:
                disabled = None
        return PalletReadiness(metadata_present=present, disabled=disabled)
    finally:
        try:
            si.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Cardano metadata probe — reads label-8746 leaves from a Cardano explorer
# (cexplorer.io / Blockfrost / kupo) and asserts our receipt's
# `attestation_evidence_hash` round-trips. The test calls into whatever
# explorer is configured by env var; if no explorer is configured the
# round-trip test skips.
# ---------------------------------------------------------------------------


def cardano_explorer_url(tx_hex: str) -> str:
    """Return the cexplorer.io URL for a Cardano preprod tx.

    Per the standing rule (`feedback_cardano_explorer.md`): use cexplorer.io
    for ALL human-facing Cardano links. cardanoscan.io is NOT used.
    """
    cleaned = tx_hex[2:] if tx_hex.startswith("0x") else tx_hex
    return f"https://preprod.cexplorer.io/tx/{cleaned}"


def fetch_cardano_metadata_8746(
    tx_hex: str,
    *,
    blockfrost_url: Optional[str] = None,
    blockfrost_project_id: Optional[str] = None,
    timeout_s: float = 15.0,
) -> Optional[List[Dict[str, object]]]:
    """Best-effort Cardano metadata fetch.

    If ``blockfrost_url`` + ``blockfrost_project_id`` are provided, query
    Blockfrost's tx-metadata endpoint and return the label-8746 entries.
    Returns None when either argument is absent — callers should skip the
    round-trip test in that case.

    This deliberately does NOT depend on a long-living Cardano client; the
    smoke harness is one-shot and a Blockfrost call is plenty.
    """
    if not blockfrost_url or not blockfrost_project_id:
        return None
    cleaned = tx_hex[2:] if tx_hex.startswith("0x") else tx_hex
    url = f"{blockfrost_url.rstrip('/')}/txs/{cleaned}/metadata"
    headers = {"project_id": blockfrost_project_id}
    try:
        with httpx.Client(timeout=timeout_s) as c:
            r = c.get(url, headers=headers)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    try:
        items = r.json()
    except Exception:
        return None
    if not isinstance(items, list):
        return None
    out: List[Dict[str, object]] = []
    for it in items:
        if isinstance(it, dict) and str(it.get("label")) == "8746":
            v = it.get("json_metadata")
            if isinstance(v, dict):
                out.append(v)
    return out


# ---------------------------------------------------------------------------
# Diagnostic helpers — used by the `pytest.skip(...)` reason strings so the
# operator running the harness knows EXACTLY which prereq is missing.
# ---------------------------------------------------------------------------


def explain_skip(prereq: str, detail: Optional[str] = None) -> str:
    """Format a uniform skip-reason string."""
    base = f"Phase 2 Path C: prerequisite missing — {prereq}"
    if detail:
        return f"{base} ({detail})"
    return base


# Convenience: small list of the ENV vars this harness consults, surfaced
# in a single skip message so an operator can see them all in one place.
HARNESS_ENV_VARS: Tuple[str, ...] = (
    "MATERIOS_E2E_GATEWAY",          # https://materios.fluxpointstudios.com/preprod-blobs
    "MATERIOS_E2E_BEARER",           # tenant-bound matra_* Bearer
    "MATERIOS_E2E_HARDWARE_SPEC",    # path to fleet-signed hardware.json
    "MATERIOS_E2E_FLEET_OPERATOR_KEY",  # optional fleet-op key for re-issue
    "MATERIOS_RPC_URL",              # ws://127.0.0.1:9945 or preprod public RPC
    "PHASE2_ADMIN_TOKEN",            # gateway admin shared secret
    "PHASE2_ATTESTOR_KEY",           # optional path to a saved attestor key
    "PHASE2_BLOCKFROST_URL",         # https://cardano-preprod.blockfrost.io/api/v0
    "PHASE2_BLOCKFROST_PROJECT_ID",  # preprodXXXXXXXX
)
