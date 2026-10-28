# PoI attestor

The package exposes attestation types, policy helpers, backend scaffolding and a
verifier registry. **No bundled backend currently performs cryptographic hardware
attestation verification.**

| Backend | Verification today |
| --- | --- |
| AWS Nitro | Fails closed; COSE_Sign1 signature and AWS root-chain verification are unavailable. |
| AMD SEV-SNP | Fails closed; report ECDSA-P384 signature and AMD VCEK-chain verification are unavailable. |
| Intel TDX, Intel SGX, GPU CC | Types only; no bundled verifier is registered. Verification fails closed. |

`verifyBundle()` and the Nitro/SNP `verify()` methods return the existing
`VerificationResult` shape with `valid: false`, every check false, no authenticated
measurements, and the optional typed field `errorCode: "VERIFICATION_UNAVAILABLE"`.
The `errors` array identifies the unavailable backend. Policies and supplied
certificates do not enable verification. The Nitro/SNP `verifyBinding()` methods
also return false: comparing caller-supplied fields cannot authenticate evidence.

`extractMeasurements()` reads untrusted fields and legacy development data. Its
output is not proof of hardware identity. The attestor implementations generate
development evidence; their output must not be treated as vendor-signed evidence.
Policy evaluation and `validateBinding()` only compare data fields.

`evaluatePolicy()` fails every check a policy requests that it cannot run:
`allowedSignerKeys` and `checkRevocation` always fail, because measurements
carry no signing key and no revocation status is looked up; `minFirmwareVersion`
fails without a reported dotted-numeric firmware version; `minSvn` fails for a
TEE that reports no SVN. `createStrictPolicy()` requests revocation checking by
default, so pass `checkRevocation: false` to evaluate a strict policy that can
pass.

Applications may register their own `AttestationVerifier`; they are responsible
for its trust roots and cryptographic checks. Tests requiring successful
attestation should inject an explicit test double into a local `VerifierRegistry`.
