# @fluxpointstudios/orynq-sdk-anchors-midnight

Orynq anchors on Midnight. This package holds the `orynq-anchor-registry` Compact contract, the
exact state it is deployed with, and the checks that refuse any other deploy. It is private
until the registry is deployed on mainnet.

## The registry contract

`contract/orynq-anchor-registry.compact` (compactc 0.31.1, language 0.23.0, runtime 0.16.0)
has two circuits. Both only write ledger state, never read it, so concurrent anchors never
conflict and nobody can block one.

| Circuit | Publishes | Proves to consensus |
|---|---|---|
| `anchor(commitment, kind)` | commitment, kind, author key | the author knows the secret behind the author key; refuses kind 2 |
| `anchor_hiding(attribute)` | commitment, attribute, author key | the author knows the secret, and an opening whose commitment is the published one |

The author key is `author_key(secret) = SHA-256(pad32("orynq:anchor:author:v1") ‖ secret)`.
Every digest is plain SHA-256 over 32-byte words, so a verifier recomputes it with any SHA-256:

```
entry_digest(root, manifest, merkle)          = SHA-256(pad32("orynq:anchor-entry:v1")  ‖ root ‖ manifest ‖ merkle)
hidden_digest(root, manifest, merkle, attr)   = SHA-256(pad32("orynq:anchor-hidden:v1") ‖ root ‖ manifest ‖ merkle ‖ attr)
hiding_commitment(digest, salt)               = SHA-256(salt ‖ digest)
derive_salt(salt_key, digest)                 = SHA-256(pad32("orynq:anchor-salt:v1")   ‖ salt_key ‖ digest)
```

### What a kind-2 anchor binds

`anchor_hiding` proves that the published commitment equals
`hiding_commitment(hidden_digest(root, manifest, merkle, attribute), salt)` for an opening only
the author holds. The published attribute is therefore bound to the published commitment: no
opening of that commitment carries a different attribute.

The circuit does not check the attribute against the trace. It treats `root` as 32 opaque
bytes, and process-trace folds the model manifest into the root hash inside a variable-length
string that no circuit reads, so a trace that ran under model manifest B can be committed with
attribute A.
Only someone holding the opening and the bundle can check that the attribute matches the
manifest bound in the root. `src/__tests__/attribute-binding.test.ts` pins both halves.

### Immutability

The registry is deployed with maintenance authority committee `[]`, threshold 1, counter 0,
and nothing else is accepted. With no committee a maintenance update needs one signature from
a member that cannot exist, so no update can ever apply; threshold 0 would admit an unsigned
one. `assertRegistryDeployBytes` decodes the exact transaction bytes, before or after proving
and binding, and refuses them unless they deploy exactly `registryInitialState()`, byte for
byte, and touch no other contract.

## Reproducing the build

```
tools/compactc/install.sh /tmp/compactc /tmp/zk-params
COMPACTC=/tmp/compactc/compactc MIDNIGHT_PP=/tmp/zk-params packages/anchors-midnight/contract/compile.sh --check
```

The installer verifies compactc and the k=13/14 parameters by sha256. The check recompiles the
contract and requires `managed/` and `HASHES.txt` to match byte for byte, and requires the same
keys and zkir when the pure circuits are not exported. The verifier keys hash to
`85dc57a4…77c5` (`anchor`, k=13) and `081384ce…790f` (`anchor_hiding`, k=14).

## Tests

`pnpm test` runs the simulator and ledger suites. `MIDNIGHT_PP=/tmp/zk-params nice -n 19 pnpm test:slow`
proves both circuits in-process (about a minute on one core) and scans the proven, bound bytes.
The npm ledger WASM does not verify contract proofs; the slow suite pins that, and nothing in
this package presents a local `wellFormed()` as proof verification.
