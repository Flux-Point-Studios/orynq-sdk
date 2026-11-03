# orynq credential broker: specification v2 (proof-gated release)

**Status:** final v2, after the operator rejected approvals as the gate and two reviews (Appendix A). v1 rules stand unless Appendix A supersedes them.
**Baseline:** orynq-sdk `main` 9fa073ae (conduct 0.1.0, process-trace 0.4.0, tool-receipts 0.2.2, anchors-materios 0.7.0, orynq-mcp 0.7.1); PoAC 2a merged (PR #221), 2b built, 2c next, slice 3 freezes the encoding ABI.
**Companions:** the coding-agent profile (components P, W, L, A; grades G/A/H) and the conduct design notes, published separately.

## 0. Decisions

1. **Agents hold capabilities:** a socket path and a session bound to issued conduct mandates (mandate-v1 CBOR, commitment C). Secrets live only in the sealed executor X or as shares on Tier-A holders.
2. **Verification gates release:** replay of the shipped `MandateGuard` from slice 1, ZK step proofs once §4.5's gates hold. Inside a mandate, a verified request is its own authorization.
3. **B holds no key.** X re-decodes everything it executes and never signs blind.
4. **Humans sign** mandates, out-of-mandate intents, admin changes and break-glass only.
5. **No host holds a whole Tier-A key:** Cardano native-script m-of-n, or FROST-Ed25519 (RFC 9591) where one key is unavoidable.
6. **FPS services drop internal bearer tokens** (§9); third-party tokens stay, injected by X, with opt-in zkTLS evidence (§10).
7. **Identities:** B `orynq-broker`, X `orynq-sealed`, Z `orynq-prover`, B-m `orynq-broker-midnight`, drain `orynq-drain`, agents `orynq-agent`. The operator has no mandate path; install gates are enforced (§5.1).

## 1. What ZK can and cannot do here

The goal: agents use credentials they can never see, even if they try.

**Cannot.**
- Third-party APIs (source hosting, DNS and CDN, package registries, chain indexers, model providers) verify bearer tokens or their own signatures, so some process sends each plaintext token; this design keeps it away from agents.
- Midnight author secrets and wallet seeds are circuit witnesses, whole in one process while proving (B-m, §7.5).
- A proof covers committed bytes: not decoder correctness (every verifier decodes again), wisdom, or completeness of the log.
- 2a's C1 is partition agreement plus audit, conditional on D12 preconditions that verifiers enforce off-circuit. Prior spend, sequence and root enter unauthenticated (2c A1–A3): verifiers' own heads discharge A1–A2; A3 needs anchored release records (§11).
- Root on X's host reads that host's Tier-B secrets.

**Can.** Keep every secret from agents and B; release nothing for a forged, replayed, stale, forked or out-of-mandate request; prove compliance to external holders and auditors without disclosing allowlist members (dictionary-testable by anyone holding C until mandateId enters K, §4.5); leave no whole Tier-A key on any host and no shared secret at our services.

## 2. Threat model

- **A prompt-injected agent** is bounded by its mandate set; misuse inside it remains possible. It cannot open sessions, choose mandates or reach X.
- **A compromised B** gets in-mandate actions on its host; it cannot read secrets, forge receipts or release records, suppress revocations (§3.4) or fork mandates (§3.1). Until signing surfaces recompute members (§3.3), it can get any mandate up to the tier ceiling signed.
- **Root, Admin, X or an X dependency** exposes that host's Tier-B secrets, which are then rotated.
- **Fewer than t holders** can only refuse; t colluding holders can sign anything.
- **A stolen authenticator**, or takeover of the cloud account behind a synced T1 passkey, issues up to its tier ceiling (§3.4).
- **Providers, same-user code, backups and W:** as v1.

## 3. Capability model

### 3.1 Mandates

Mandate-v1 CBOR is used as shipped; §4.5's ABI changes touch only K and the guard-event template.

| Field | Broker use |
|---|---|
| principalDid | did:key of a pinned authenticator credential (P-256 or Ed25519) |
| agentDid | did:key of the broker instance key, held by X |
| spendCap | cap per tumbling window in `lovelace`, `midnight:dust` (SPECK) or `orynq:call` (1 per use) |
| counterpartyAllowlistRoot | allowlist over §3.2 strings, ≤ 256 members (D = 8) |
| egressPolicy | mode 0, zero root (egress stays with W) |
| approvedMeasurementSetRoot | reviewed X builds, enforced once attestation is real (§8.3) |
| validityWindow | ≤ 7 d at T1, ≤ 90 d at T2 |
| disclosurePolicy | evidence-escrow committee, unchanged |

Each mandate has one **executor domain**, signed in issuanceDigest: `X:<brokerId>` or `committee:<rosterId>`. Verifiers refuse other domains' mandates and out-of-domain aliases, so each mandate has one head-keeper. A session binds a **mandate set**: at most one mandate per (asset, domain), one principalDid, one agentDid. Mandates are superseded after 2^17 trace events.

### 3.2 Capability strings and action mapping

- `cap(kind, alias, rule) = "oc1:" ‖ hex(SHA-256("orynq:broker:cap:v1|" ‖ dCBOR({0: kind, 1: alias, 2: SHA-256(dCBOR(rule))})))[0:60]`. Editing a rule changes its string, so `policy.update` cannot widen an issued mandate.
- Cardano counterparty: `"ca1:" ‖ hex60(SHA-256("orynq:broker:cardano-cp:v1|" ‖ networkId ‖ paymentCred ‖ stakeCred?))`. Fees go to `cap("cardano.fee", alias, rule)`.

| Effect | Actions (one clock sample) |
|---|---|
| `http.request`, ssh sign, `substrate.sign*` | `orynq:call` 1 → rule `cap` |
| `cardano.signTx` | `orynq:call` 1 → `cap`; `lovelace` Σ per external counterparty → `ca1`; fee → fee `cap` |
| `midnight.anchor` | `orynq:call` 1 → `cap`; `midnight:dust` fee → `cap("midnight.fee", …)` |

**Canonical order:** mandates by C; within one, the call, outflows by ca1 bytes, then the fee. Any unmapped part (certificates, withdrawals, mint, collateral, foreign or script inputs, external assets, unlisted labels, body keys 19–22, `ssh.cert`, `midnight.deploy`, credential endpoints, SigV4) makes the effect **out of mandate**: approval (§12) or refusal. Release needs ALLOW on every action.

### 3.3 Issuance

1. **Prepare.** `mandate.prepare {draft}` (`mandate-draft.cddl`) arrives on the admin socket or W's page; B fills a random mandateId and the agentDid and returns CBOR, C, K, members and a summary.
2. **Sign.** The signing surface (W's page from slice 2, or the offline CTAP2 host) ignores B's summary: it decodes the CBOR, recomputes C, each oc1 from `policy.cbor` at the signed policyHash and each ca1 from the addresses it shows, checks the root, and displays only what it derived. The principal signs `issuanceDigest = SHA-256("orynq:broker:mandate-issue:v1|" ‖ C ‖ supersededC ‖ policyHash ‖ domain ‖ nonce16)` as a WebAuthn challenge, or offline as a CTAP2 clientDataHash (rpId `orynq-broker`, libfido2 `fido2-assert`, no agent on that host).
3. **Register.** `mandate.register {cbor, members, domain, assertion, purpose}`, members being `{cap: {kind, alias, ruleDigest}}` or `{ca1: {networkId, paymentCred, stakeCred?}}`. X and holders recompute members from their own alias table and pinned policy, require the rebuilt root to match, check principal pin, tier, ceilings, signature, UV, rpId or origin and signCount, and persist members. `mandate.issued` is journalled and anchored; purpose text is hashed for the record only.

**zk-only holders** (§8.3) lack the CBOR, so they accept C only if issued at T2, with a verified S-MANDATE-OPEN proof for K and a registration record over {C, K, domain, tier} co-signed by t FPS holders; after the ABI freeze they also match the disclosed SHA-256(agentDid) and SHA-256(principalDid) to the request and issuance signers.

### 3.4 Widening, revocation, ceilings

- **Widening** issues a mandate that `supersedes` C at the tier its terms need, revoking C atomically; spend carries over (in window q, refuse unless spent[C][q] + spent[C'][q] + amount ≤ cap(C')). **Narrowing** to a strict subset needs only T1.
- **Tier ledger.** Verifiers keep spent[principal, tier, alias, asset, q] across all mandates and approved intents and refuse past the tier ceiling, so parallel mandates and supersede chains cannot exceed it; circuits are unchanged.
- **Revocation** (`mandate.revoke`) is permanent and needs no human; the principal, B (own mandates), a lockout or a W quarantine may revoke. X takes revocations on `revoke.sock` (operator and W only), and from slice 2 W anchors a signed revocation-list head on Materios every 5 min and on each change, read by X and holders from their own node. A verifier whose newest verified finalized head is over 10 min old fails closed.

### 3.5 Session binding

L calls admin `session.open {mandates: [C…]}`; B checks each C (registered, unrevoked, valid, allowed for the unit class) and the set (§3.1), allocates the session (§5.2), journals `session.bound` and commits the set into every intentHash. Agents cannot change mandates; spend accrues per mandate across sessions.

## 4. Proof-gated release

### 4.1 Guard evaluation and mandate trace

B keeps per mandate a live `MandateGuard` behind a staging sink and a TraceRun (the **mandate trace**) of `orynq.conduct.guard.v1` CustomEvents only (2b template, `private`).

Per intent, B locks mandates in sorted-C order (one intent in flight each) and enforces the canonical sequence at one clock sample. If all actions ALLOW, the staged events go to X in one `release.commit`, persisted across mandates atomically. Otherwise nothing commits: the intent fails with -32003 `conduct:<REASON>`, the scratch evaluation is journalled (grade H), and B rebuilds those guards from `release.history`. Denials thus consume nothing, cannot grief a cap and never enter a provable chain (keeping unprovable denials 5 and 7 out of ZK).

X-signed **release records** `{intentHash, effectDigest, heads: [{C, prev, next}], notAfter, mode, proofRefs?}` sit outside the guard trace; effectDigest is the requestHash (http) or bodyHash (signTx). A **head** is `{guardLog: {count, hash}, trace: {roll, seq}}`: replay authenticates the guard log (conduct `log.ts` compare-and-swap), ZK the roll. Traces share one genesis, so head, successor and consumed tables are keyed by (C, head).

### 4.2 Release request

```
ReleaseRequest = {v: 1, intentHash, kind, alias, effect (validated params or full tx bytes),
  mandates: [{C, head, steps: [{event, traceMeta: {id, seq, timestamp},
    proof?: {circuitId, classId, transactionBase64, referenceStateBase64}}]}],
  approval?, instanceSig?}
```

Schema and vectors: `release.cddl`; no secret inside. For committee mandates X runs `verifyRelease` without persisting and adds `instanceSig`; B forwards to holders; X advances its head only on their quorum certificate (§8.4).

### 4.3 Statement

Per mandate C: K commits C's atoms and the CBOR satisfies `validateMandate` (ZK: S-MANDATE-OPEN once; replay: strict decode). Per event e_j: its recorded decision equals ConductVerdict(atoms(K), a_j, priorSpent_j, enforcedAt_j) = 0, with membership under K's root and time and clock in window q_j (ZK: S-CONDUCT-STEP; replay: `MandateGuard.enforce`), and roll_j = SHA-256("poi-trace:roll:v1|" ‖ hex(roll_{j−1}) ‖ "|" ‖ hex(H(e_j))). Issuance, revocation, a_j and effectDigest are checked off-circuit (§4.4). Steps disclose prevRollHex, rollAfter, K, windowIndex, priorSpent, verdict, dataSeq and traceSeq.

### 4.4 Verifier checks

X and every holder run one `verifyRelease`, failing closed, in order:

1. **Mandate:** registered for this domain, unrevoked, fresh revocation view, verified issuance; replay needs CBOR and members, ZK needs K with a verified S-MANDATE-OPEN proof; holders require `instanceSig` by C's agentDid.
2. **Effect:** strict decode with the pinned decoder and own chain node; recompute effectDigest and a_1..a_m in canonical order; rebuild each e_j.
3. **Clock** (D12): now − tol ≤ enforcedAt ≤ now + 2 s (tol 60 s, plus measured proving p99 under ZK), non-decreasing per mandate; action time ≤ enforcedAt, non-decreasing, and in enforcedAt's window; notBefore ≤ now < notAfter on the verifier's clock; request notAfter > now; signTx TTL ≤ now + 2 h.
4. **Continuity:** both head chains equal the verifier's own; seqs are consecutive.
5. **Verdict.** *Replay:* each a_j on the verifier's live staged guard yields the identical event with ALLOW. *ZK:* each proof verifies natively against its class's registry entry, and decoded cells show registered K, verdict 0, recomputed rollAfter_j, and priorSpent_j equal to the verifier's own spent[C][q_j].
6. **Ceilings:** tier ledger and carry-over (§3.4) admit the amounts.
7. **Single use:** intentHash unconsumed.
8. **Persist with fsync** heads, spend, tier ledger, consumed intentHash and (C, head) → successor; then release.

A head extends once, so it is the nonce. Failures return `VERIFY_REFUSED` and count toward lockout; a B/X disagreement pages.

### 4.5 Replay now, ZK behind gates

**Replay** (the shipped `MandateGuard`, D12 included) is sound for verifiers allowed to see the mandate and gates every release until these gates hold.

**Why 2c is too early.** 2c yields real proofs and native-verifier evidence only for k ≤ 16 (stop S6). Step classes are ESTIMATEs: `st_pa` (4-byte ids, D = 2) ≈ 99k rows, k = 17; broker steps (64-byte ids, D = 8) near k = 18. Exact-length classes multiply amount and seq widths into hundreds of verifying keys (`orynq:call` alone ≈ 49), the predicted R-ENC failure.

**Gates, in order:**
1. **ABI freeze** (PoAC slice 3) with broker inputs: F3 fixed-width guard events (zero-padded uint64 decimals and seqs, fixed asset digest) or F4, per R-ENC with a broker class count; mandateId in K's preimage (209 bytes, still 4 SHA blocks), making K hiding; S-MANDATE-OPEN disclosing SHA-256(agentDid) and SHA-256(principalDid).
2. **Params:** the operator authorizes a pinned 2p17/2p18 fetch (R-K).
3. **Broker classes** compiled and keyed, each with a verifier-registry entry and disclosed-cell decoder (`posted.ts` pattern); a named PoAC-lane work item.
4. **Real proofs** on those classes verify natively.
5. **Measurement:** per-intent proving p95 (summed over steps) and RSS on Z hardware, against 30 s and a capacity budget.

**Encoding epoch.** ZK covers only traces begun under the frozen ABI; mandates are superseded at the switch.

**Modes** (per verifier in `policy.cbor`, T2, forward-only): `replay` → `replay+zk-shadow` after gates 1–5 (replay decides; disagreement pages) → `zk+replay` after ≥ 14 d and ≥ 1,000 real steps of agreement, tampered proofs failing, ≥ 99% of steps classed → `zk` for external holders without preimages. Earlier ZKIR-check shadows are telemetry, since `check` verifies no proof (S13).

**Scope.** ZK adds no soundness for a local X, so X-domain mandates, high-rate `orynq:call` ones included, stay on replay; committee mandates are proved, with verifying keys derived from pinned ZKIR and installer-verified params.

### 4.6 Prover Z

`orynq-prover`: own uid, no vault, AF_UNIX only. midnight-prover's `native/` crate is verify-only, so Z runs the `@midnight-ntwrk/zkir-v2` WASM prover with pinned `bls_midnight_2p{k}` params; X and holders run the native verifier. Agents never prove; `intent.submit` has no proof field.

## 5. Architecture

- **B:** sockets, sessions, registry, decoders, guards, journal, coordination, FROST relay. No key; AF_INET only to pinned Kupo/Ogmios (`IPAddressAllow=`).
- **X:** vault, `verifyRelease`, executors, redaction, and the instance, receipt and release-record keys. Only B reaches `release.sock`; only the operator and W reach `revoke.sock`.
- **Z** proves; **B-m** runs Midnight jobs for X; the **drain** is a service client of B (§11).
- **W, P, L, A:** as in the profile; W adds acknowledgements, approval origin, push, the revocation head, provider keys and the egress proxy.
- **Holders** (slice 3): `orynq-share` on cert-daemon hosts, running `verifyRelease` plus frost-ed25519 or a script key against their own Cardano node, Kupo and Ogmios.

All run under v1 unit hardening with 0700 state per uid; only X gets `LoadCredentialEncrypted=identity`.

### 5.1 Install gates

A checks hourly; while any gate fails, B serves only `test:` aliases. Gates: no NOPASSWD sudo on agent accounts (pam-u2f); the operator outside `docker`, `lxd` and `adm`; no agent running as the operator; one uid per client service; kernel ≥ 6.13.

### 5.2 Principals and sessions

Principals: `agent:<sessionId>` (an `orynq-agent` peer in the session's cgroup), `operator` (the operator's uid), `service:<name>` (a uid with its unit cgroup, or a peer on bind-mounted `svc/<name>/rpc.sock`); others get `PEER_UNKNOWN`. `session.open` returns a random 128-bit sessionId and unit `orynq-agent-<sid>.service`, which L starts via `systemd-run --pty --uid=orynq-agent` in the root-owned `orynq-agents.slice` (`PrivateTmp`, `PrivateIPC`, no AF_VSOCK); polkit allows the operator only these units. B admits a peer only if `PIDFD_GET_INFO` on `SO_PEERPIDFD` returns the unit's cgroup.

## 6. Interface

### 6.1 Framing

A frame is a uint32 big-endian length N (1 ≤ N ≤ 16 MiB) plus one UTF-8 JSON-RPC 2.0 request with an id; batches, concurrency and id-less requests are refused. `parseStrictJson` returns -32700 for duplicate keys, lone surrogates, a value inside more than 32 containers or a request holding more than 65,536 values (every container, string, number and literal; keys do not count), both judged before parsing, or numbers beyond ±2^53; uint64s are decimal strings. The largest params any method allows, a `release.commit` of 8 mandates of 258 steps, hold about 50,000 values. Connections close after 300 s idle (≤ 8 per agent, 32 per other principal, and 32 per account without one: a uid, a SID, or all unidentified clients together); the clock restarts when a reply is queued and when it drains, so a reply left unread closes the connection too. A client may shut down its write side after a request: B still answers it, then closes. A stream error closes the connection. Clients require an `orynq-broker`-owned socket, in directories only root or `orynq-broker` can change, before sending a byte. As on Windows (§16b), a small Rust frontend owns B's Linux sockets and passes `(connId, peer, frame)` to B over stdio: the peer is `SO_PEERCRED`'s uid and gid and the cgroup of the process `SO_PEERPIDFD` names, read while that pidfd shows the same live pid and matched to `PIDFD_GET_INFO`'s cgroup id (the frontend refuses to start where the kernel reports none, as before 6.13); a client it cannot identify gets `PEER_UNKNOWN`. The frontend bounds each peer to 32 connections, each uid to 128 and all to 1,024 or what its descriptors allow, and the request bytes it holds to 64 MiB per uid and 256 MiB in all; B caps each principal, and each account without one, since any account can multiply its peers by creating cgroups.

### 6.2 Methods

| Method | Params → Result |
|---|---|
| `broker.hello` | `{}` → `{protocol: 2, brokerId, receiptKey, policyHash, principal, sessionId?, mandates, verifyMode, journalHead}` |
| `credential.list` | `{}` → capabilities with their `mandate` |
| `mandate.get` | `{mandate}` → `{cbor, summary, windowIndex, spent, notAfter}` |
| `intent.submit` | `{kind, params, mandates: [C], expect?, wait?, note?}` → `Intent` |
| admin `session.open`, `.close` | `{mandates}` / `{sessionId}` → `{sessionId, unit}` |
| admin `mandate.prepare` | `{draft}` → `{cbor, C, K, members, summary, issuanceDigest}` |
| admin `mandate.register`, `.revoke` | `{cbor, members, domain, assertion, purpose}` → `{C}`; `{mandate, reason}` → `{}` |
| X `release.commit`, `release.history` (B only) | `ReleaseRequest` → `{status, result, heads, releaseRecord}`; `{C, fromCount}` → `{events, head}` |

Other v1 rows and bounds are unchanged. As JSON-RPC 2.0 allows, a request may omit params; B reads them as `{}`. Only an agent has a session, so only its hello carries `sessionId`, with its session's `mandates`; `journalHead` is `{seq, hash}`, the row count and the last row's hash (32 zero bytes before the first row). A method the caller's principal may not call, admin methods for an agent or service included, is -32601, as is a method B does not serve yet; a peer with no principal gets `PEER_UNKNOWN` for every request. Effect methods are `intent.submit` with the method as kind and a 30 s wait; `mandates` must equal B's §3.2 derivation; `expect` (`{calls, outflows, fee}`) mismatching the decode is `DECODE_REFUSED`. `Intent = {intentId, requestHash, intentHash, status, mandates, release?: {mode, steps, proofRefs?}, result?, approval?, error?: {code, reason, rule?, field?}}`. Statuses are v1's; `uncertain` is never retried.

### 6.3 Errors and hashes

Messages come from a fixed table; `field` is a decoder path; no reply carries upstream or vault data. Standard -32700…-32602 (unknown fields, non-canonical values, null, negatives and floats are -32602). v1 codes -32001…-32010 are unchanged (`PEER_UNKNOWN`, `ALIAS_UNAVAILABLE`, `POLICY_REFUSED` with rule `conduct:<REASON>` for guard denials, `DECODE_REFUSED`, `APPROVAL_DENIED/EXPIRED`, `UPSTREAM_FAILED`, `*_UNAVAILABLE` now covering holders, `LOCKED_OUT`, `RATE_LIMITED`, `INTENT_UNKNOWN`); unknown, foreign and forbidden aliases are indistinguishable and never decrypted. New: -32011 `MANDATE_REFUSED` (unknown, revoked, expired, wrong domain, outside the set); -32012 `VERIFY_REFUSED`.

**JSON-to-dCBOR profile:** keys in conduct `cborEncode` order; integers and decimal-string uint64 to uint; strings to text; floats, null and negatives refused. CDDL uses bytes, text and uints, with golden vectors per effect kind.

**Schemas.** `packages/broker/docs/params.cddl`, `mandate-draft.cddl` and `release.cddl` are normative for every §6.2 method's params, the `mandate.prepare` draft, the ReleaseRequest and the release record; the runtime schema is held to them by vectors and by bound probes on every member of every rule. They decide what this spec leaves open:
- **Sets:** a session binds 1–16 mandates and an intent or release 1–8; a draft or `mandate.register` carries 1–256 members; a mandate release holds 1–258 steps and a release record 1–258 proofRefs (one call, 256 outflows and one fee: a loose cap that verifyRelease narrows).
- **Identifiers:** executor domains are `X:` or `committee:` plus 32 bytes of lowercase hex; sessionId is 16 bytes; capability kinds, aliases (a `test:` prefix allowed), did:key, oc1 and ca1 strings, trace event ids (UUID) and trace times (ISO 8601 UTC with milliseconds) match fixed patterns.
- **Assertions:** WebAuthn `{credentialId 1–1023, authenticatorData 37–1024, clientDataJSON 1–4096, signature 8–72, userHandle? 1–64}` bytes or CTAP2 `{credentialId, authenticatorData, signature}`; an approval is `{nonce: 16 bytes, assertion}`, and an approved out-of-mandate release carries `mandates: []` with it.
- **Sizes:** text in UTF-8 bytes: note ≤ 256, reason 1–256, purpose 1–1024, committeeId 1–128; proof base64 fields 4 bytes to 1 MiB; the `mandate.register` CBOR 1–2048 bytes.
- **Events:** a release's guard events are payment action events only, since denials never enter a mandate trace (§4.1).
- **Wire form:** a uint whose bound is at most 2^53 is a JSON integer; any other, notBefore, amounts, seqs and timestamps included, is a canonical decimal string, so each value has one spelling; an integer spelled as a float (`1.0`, `1e0`) is -32700.

Checks the CDDL cannot express belong to the handlers and verifyRelease and are not built yet: notAfter > notBefore and the tier's validity span (§3.1, §12); threshold ≤ committeeSize; each step's mandateCommitment equal to its C; recomputed action digests, canonical order and one outflow per counterparty (§3.2); guard and trace seqs continuing from each head (§4.4); `expect` matching the decode (§6.2). The release vectors already satisfy the step checks.

```
requestHash = SHA-256("orynq:broker:request:v1|" ‖ dCBOR({0: kind, 1: params, 2: salt16}))
summaryHash = SHA-256("orynq:broker:summary:<kind>:v1|" ‖ dCBOR(summary))
mandateSet  = SHA-256("orynq:broker:mandate-set:v1|" ‖ dCBOR(sorted [C…]))
intentHash  = SHA-256("orynq:broker:intent:v1|" ‖ dCBOR({0: requestHash, 1: summaryHash, 2: kind,
              3: [alias, keyId, aliasRevision], 4: principal, 5: sessionId, 6: policyHash, 7: notAfter, 8: mandateSet}))
```

`wait`, `note` and `expect` are unhashed; salt16 lives only in encrypted rows. `keyId`, `brokerId` and `policyHash` hash the public key, receipt-key SPKI and `policy.cbor`.

## 7. Handlers

An alias `{type, keyId, revision, principals, rules, policy, domain}` holds one key or token with a vault-unique fingerprint. Agents never hold service, drain, CI or provider aliases.

### 7.1 http

Alias: `{inject: {header, template} | {pathTemplate}, rules: [{host, port, methods, pathPrefixes, queryKeys?}], callerHeaders, deny, maxReqBytes, maxRespBytes ≤ 12 MiB, timeoutMs}`. v1's request rules hold: HTTPS to exact A-label hosts; no userinfo, fragments, wildcards, PSL multi-tenant suffixes, dot segments, `%2e`, `%2f`, `%5c`, `\`, `//` or `;`; `/`-boundary prefixes; allowlisted caller headers; X alone sets method, authority, path, Content-Length and `Accept-Encoding: identity` over fresh HTTP/1.1 connections. Header or `pathTemplate` injection (for APIs that carry the token in the URL path); SigV4 stays human-only. Credential endpoints need T2 per call, and the v1 deny list applies after normalization (source-host keys, runner and installation tokens and repository secrets; DNS and CDN token management such as `/user/tokens`; hosting-platform environment-variable reads; CI secret and pipeline-run endpoints; GraphQL without persisted queries). `alias.put` refuses key, token, secret and env-admin scopes. Network handling is v1's; from slice 2 X egresses via `CONNECT` through W.

**Redaction** happens in X before B sees a byte: the secret and injected value in every v1 encoding across chunk boundaries, plus credential shapes and HMAC fingerprints of vault secrets. A hit locks the session.

### 7.2 ssh

B serves `ssh-agent.sock` (ssh2 AgentProtocol, MIT), the only `SSH_AUTH_SOCK` L sets; X signs. Only REQUEST_IDENTITIES, SIGN_REQUEST and a verified `session-bind` to a rule host key pass (`agent-restrict.sh` vectors); X signs only `publickey` USERAUTH_REQUESTs for the bound session and an allowed user, never SSHSIG. root, the operator's account and sudo, wheel, docker, lxd or adm members are refused targets; keys carry `restrict,from=<W egress>`. `ssh.cert` (T2) issues 10-min forced-command certificates. Source hosts: one deploy key per repository.

### 7.3 cardano.signTx

`packages/cardano-tx-reader` builds on `plutus-cbor-codec`; the strict Conway decoder is new work. It accepts exactly one `[body, witnesses, isValid, aux]` with no trailing bytes, refusing duplicate keys or set elements, indefinite lengths outside Plutus Data, a key 7 not matching aux, keys outside 0–5, 7–9, 11 and 13–22, and a missing TTL. bodyHash = BLAKE2b-256 of the original body bytes.

ChainSource pins Kupo/Ogmios to one tip and its parameters plus released transactions' unconfirmed outputs, and checks value preservation including deposits and donations. Own outputs pay the alias key with the recorded stake credential or none; counterparties compare on credential bytes; stake and HD-derived keys are separate T2 aliases. In mandate also requires the alias's network, TTL ≤ now + 2 h, signers ⊆ {alias}, no Byron, pointer or non-canonical addresses, only the rule's metadata labels, fee ≤ maxFee. A counterparty denylist refuses even approved transactions.

X signs with CSL `PrivateKey` (single-key re-signs are identical). `BrokerSigner` implements `ExtendedSigner.signTransaction`; `sign` and `signMessage` throw. Hash-only `signTx` is dev-only; CIP-8 uses its own alias.

### 7.4 substrate

`signPayload` decodes against pinned-genesis metadata, builds extensions under v1's era, tip and address rules, and accepts exact (pallet, call) pairs (no sudo, proxy, dispatch or multisig wrappers; `utility.batch_all` to depth 2). It replaces every `SIGNER_URI`; slice 1a ships only the drain's receipt call. `signUpload` builds `materios-upload-v2|…` itself for allowlisted paths and |ts − now| ≤ 60 s.

### 7.5 Midnight (slice 2)

B-m runs under its own uid with `MemorySwapMax=0`, reaching only the Midnight node; X passes the seed per job as a sealed memfd over a socketpair, so it never touches a file or swap. `midnight.anchor` keeps v1's prepare, exact-bytes and summary steps. The standing anchor approval becomes a mandate (0.1 DUST per 86,400 s, 0.01 DUST maxFee, pinned payer, authors and registry). PTY typing, `approvals/` and `used/` retire; the chain-indexer API key becomes an `http.open` alias; author validity windows age out any exposed author secret.

### 7.6 Provider keys

W loads provider keys through `packages/broker/vault` and enforces per-session token budgets.

## 8. Threshold signing for Tier-A keys

### 8.1 Mechanism per key

- **Treasury wallets:** native script `atLeast t` over holder keys (no new cryptography; a visible script and t witnesses).
- **Single keys** (known-authors root; a token admin key if its validator checks one pkh, since a new pkh is a ceremony; non-script governance credentials): `frost-ed25519` (ZcashFoundation, MIT/Apache-2.0), dealerless DKG; NCC audited v0.6.0, so the diff to the pinned version is reviewed before Tier-A use.
- **Cardano caveat.** The ledger verifies plain Ed25519, so a FROST group key works as a credential, without mnemonic, hardened derivation or hardware-wallet import (soft derivation possible, unused); HD wallets are swept to new addresses. Midnight keys stay whole (§1).

### 8.2 Protocol

n holders on separate hosts, t ≥ ⌊n/2⌋+1; roster, attested holder identity keys and threshold pinned on Materios (cert-daemon committee pattern).

**DKG and resharing.** Round-1 package hashes are anchored on Materios and checked before round 2; round-2 packages are HPKE-encrypted (RFC 9180) and signed holder to holder, so B relays ciphertext; the group key and verifying shares are published on chain and checked before first use. Resharing reuses this; old shares are deleted with an attested record.

**FROST signing.** Each holder keeps its nonce pair in memory only (a crash means a new round 1), runs `verifyRelease`, persists the result, signs its own recomputed bodyHash, zeroizes the nonce and emits its share. B checks the aggregate with CSL or libsodium (the ledger's cofactorless check) before submitting. Native-script holders sign bodyHash after `verifyRelease`. **Idempotency** per (C, prev heads, intentHash, bodyHash): a repeat gets a share under a fresh nonce without extending the head; a different successor is never signed; threshold paths dedupe by txid.

### 8.3 Holder trust and roster

Holders register through pallet-tee-attestation; measurement checks wait until packages/attestor's Nitro and SNP verifiers reject mocks (conduct design notes). FPS-operated replay holders come first; with ZK, Witness Network attestors join as paid `zk`-only holders (§3.3), growing the attestor pool. **Roster rule:** neither FPS (f) nor external (e) holders alone reach t: f, e ≤ t−1 (native scripts: `all [atLeast 1 FPS-keys, atLeast t' external-keys]`).

### 8.4 Equivocation and sync

Each holder signs a **successor record** `{intentHash, bodyHash, [C, prevHeads, nextHeads] per mandate}` and refuses a second successor to any (C, head); t records form a **quorum certificate**. As t > n/2, two successors reach t only if some holder signs both, and its records attribute the equivocation; slashing awaits a bonded seat and a Materios extrinsic checking conflicting records. Lagging holders pull steps from W or anchored release records and accept each only with its certificate. Holders restored from snapshots stay out until resharing.

## 9. Credentials for FPS services

### 9.1 Slice 2: RFC 9421 signatures

The Materios blob gateway, orynq gateway and other FPS APIs take bearer tokens today. X holds Ed25519 keys and signs; services verify with a maintained RFC 9421 library (Node and Python, vetted in slice 2), since tool-receipts' `verifyHttpMessageReceipt` trusts a caller-supplied base and embedded keys. The service rebuilds the base from the received request: `"@method"`, `"@authority"`, `"@path"`, `"@query"`, plus `content-digest` (RFC 9530, checked against the body) when present; `created` within 60 s, 128-bit `nonce`, `keyid`, `alg="ed25519"`, `tag=<service audience>`; keys only from `orynq-service-keys/v1`, signed by a T2 YubiKey root (FROST known-authors root from slice 3); a shared (keyid, nonce) cache; scope checked against method and path.

FPS-internal and admin bearer tokens are deleted. `matra_` customer keys, which anchors-materios sends as bearer tokens, get an announced migration window. Blob uploads keep `materios-upload-v2`.

### 9.2 Slice 4: membership credentials

A new Compact 0.31.1 contract on ledger 8 (deployment needs the operator's approval). The issuer inserts `cm = persistentHash(domain, sk_c, attrsDigest)` into a `HistoricMerkleTree`, gated by the anchor registry's `author_key` pattern; attrsDigest binds audiences, scopes, an issuer-set notAfter and a revocation epoch. X, holding sk_c (zkir-v2 prover in X's TCB), proves knowledge, membership, notAfter and epoch, disclosing audience, scope, a fresh session key and `nf = persistentHash(domain, sk_c, audience, epoch)`; services rate-limit and deny-list by nf while sessions stay unlinkable across audiences and epochs. The service verifies natively off-chain against a root its own node finalized within the revocation bound, then accepts RFC 9421 requests under the session key for up to 1 h. Open question U-C1: whether off-chain verification of a transcript reading a historic root works.

`proveCapability` does not fit (no issuer authority, one commitment per context, every presentation published). **Ledger 9** issuer-signed credentials (zk-loan style) need in-circuit Ed25519 or P-256 from Compact 0.35; all networks run ledger 8.1.2 with compactc 0.31.1.

## 10. zkTLS evidence

For releases, DNS changes and package publishes, X runs the TLSNotary prover (Apache-2.0/MIT, pinned, labelled unaudited alpha); W notarizes in slice 4, Witness Network attestors later.
- **Disclosed:** server name and chain, request line, allowlisted headers, body hash, status, selected ranges, and an `Orynq-Request: <requestHash>` header binding the attestation to its intent. **Redacted:** the injected bytes; in MPC mode the notary never holds session keys.
- **Limits:** TLS 1.2 only; MPC uploads about 30 MB and takes 3–15 s per 1 KB/2 KB exchange. Proxy mode requires an in-circuit key-schedule proof, since AES-GCM is not key-committing.
- **Grade:** a colluding prover and notary can forge transcripts, so attestations are A while FPS runs both, G with an independent notary.

## 11. Conduct, journal, receipts, anchoring

**Journal.** node:sqlite (WAL, `synchronous=FULL`, one writer): `journal (seq, intentId, state, event, prev, hash)`, `hash = SHA-256("orynq:broker:journal:v1|" ‖ prev ‖ dCBOR(event))`, plus mandates, sessions, traces and approvals. X holds what decides release: heads, live guards, spend, tier ledger, consumed intents and release records. Traces persist as `{rollingHash, nextSeq}` plus append-only rows.

**States:** received → decided → (pending → approved/denied/expired/cancelled) → executing → done/failed/uncertain. `decided` and `executing` are fsynced (W-acknowledged from slice 2). The vault opens only in X after `verifyRelease`. At executing and on restart X re-checks lockout, policyHash, alias revision, revocation, approval expiry and TTL; a mismatch expires the intent. An interrupted HTTP call becomes `uncertain`.

**Lockout.** Every refusal code counts, at B and X separately, as do cancelled approvals and canary use: three in 10 min lock the session, six on one host lock its sessions, a designated canary locks its principal fleet-wide, and a non-X vault open locks every agent. Lockout cancels pending intents and revokes the session's local mandates; clearing it takes T2.

**Receipts.** X signs a ToolReceiptEvent per `done` row over the result it executed (`createSigningProxy`, EdDSA, bound to `{runId, requestHash}`), so B cannot forge one: `toolId` `<kind>:<alias>`, `request.hash` requestHash, payload `{v:1, kind, status, bodyLen, bodySha256}` (signTx: `{v:1, kind, bodyHash, vkeyWitnessSha256}`), `response.hash` `hashToolPayload(payload)`. `orynq-broker verify` pins keys with `trustEmbeddedKeys` false.

**Drain.** `orynq-drain` reads journal rows and release records over its svc socket and, every 60 s or 256 rows, runs `submitCertifiedReceipt` on `dCBOR([{brokerId, fromSeq, toSeq, headHash}, age(rows → the operator's offline recipient)])` plus issuances, revocations and clear release records `{C, rollAfter, proofRef}`; proofs go to the blob gateway. Its extrinsics are X-signed `substrate.signPayload` intents, so anchors-materios gains an injected polkadot `Signer` (slice 1a, with its `substrate.json`). Effects fail with `JOURNAL_UNAVAILABLE` past 1,024 unanchored rows or 10 min.

**Grades.** **G:** assertions, holder signatures, independently notarized zkTLS, on-chain transactions whose release record carries a step chain verifying under an issued mandate (public audit needs the anchored chain from genesis; one proof shows per-step compliance only). **A:** non-X vault opens, W-notarized zkTLS. **H:** the journal, refused-intent evaluations.

## 12. Human approvals (exception path)

Approvals cover only mandate issuance or widening, out-of-mandate intents, `policy.update`, `alias.put`, `lockout.clear` and break-glass.

**T1** is the principal's phone passkey, with ceilings counted across the principal's mandates and approvals: ≤ 300 ADA and ≤ 0.1 DUST per 86,400 s tumbling window (up to 2× in one sliding 86,400 s), ≤ 500 calls/h, ≤ 7 d validity, no Tier-A alias or credential endpoint; out-of-mandate approvals ≤ 100 ADA/tx. Synced credentials (BE set at enrolment) pass with signCount 0 on the single-use challenge and a BE/BS flag policy.

**T2**, for everything else, is an attested YubiKey 5 (pinned AAGUID) with two pinned credentials, offline CTAP2 (rpId `orynq-broker`) and NFC WebAuthn on the approval page's domain; either may be a principal.

**Verification.** WebAuthn via @simplewebauthn/server (MIT), CTAP2 via @noble/curves over `authData ‖ clientDataHash`; challenge issuanceDigest or intentHash ‖ nonce16. X and holders check rpId and origin, UV, signature, signCount per enrolment type, tier and single use. Expiry: 15 min signTx, 24 h Midnight, 1 h issuance.

**Approved out-of-mandate release** carries no guard steps and advances no head; X records `{intentHash, assertion, decoded summary}`, freshness uses approval expiry and notAfter, and approved lovelace counts only in the tier ledger.

Delivery and page are as v1; T2 keys never touch an agent host. In slice 1 the YubiKey issues offline and out-of-mandate intents return `no-approver`. **Break-glass:** a dedicated YubiKey turns acknowledgements off for ≤ 6 h while W is down (journalled, anchored).

## 13. Storage

As v1, owned by X: `vault/<alias>.age`, encrypted to X and to an X25519 recovery recipient whose key exists only as ciphertext to two YubiKeys; a TPM2-sealed identity; a T2-written SHA-256 vault index (mismatch pages). X generates its keys; tokens are encrypted to X at T2. `alias.put {rotate}` changes rule digests, re-issuing affected mandates. Tokens rotate every 90 days and on suspected exposure; Tier-A keys by resharing or a new script. Host loss: recover on a clean host with a YubiKey, then rotate every Tier-B key.

## 14. Migration

A step is done when P's detectors find nothing at the old path, no environment carries the credential, and the alias has run under its mandate in its real runtime. Step 0: a root inventory of names.

1. Offline genesis ceremony: policy, principals, service mandates, both T2 credentials.
2. The drain; the Midnight runner and standing service.
3. The anchor submitter on its own uid (its own metadata label, change-only; `SIGNER_URI` becomes `submit_anchor`); the trace drain off the operator's uid and its environment file.
4. cert-daemon and evidence-submitter via `svc` sockets and a Python client; bonding stays out of mandate.
5. FPS services: RFC 9421, internal and admin bearer tokens deleted, `matra_` window opened.
6. DEX keeper and filler services: a broker on their host with the services' existing signing guards as rule validators.
7. CI: audited image filters, the source host's token under the plugin pattern, hardware-signed tags, no secrets in PR pipelines.
8. Remaining agent tokens: deleted, human-only, or capabilities; `Environment=` lines, env files, agent client configs, `~/.orynq/config.json` and rc files purged.
9. orynq-mcp drops keys and adds `broker_credentials`, `broker_mandate`, `broker_http`, `broker_intent_*`; installers write only the socket path; quickstart keys come from X.
10. Tier-A (slice 3): swept at T2 to script or FROST addresses; proxy mode runs `HTTPS_PROXY` with a CA only `orynq-agent` trusts, name-constrained to rule hosts.

## 15. Slices and acceptance

Tests are RED first and scored by the harness; `substrate.json` changes with the code.

**Slice 1a (days 1–7):** `packages/broker` (RPC, sessions, registry, staged guards, CDDLs, replay X, tier ledger, `revoke.sock`, http, receipts, journal, client, drain), the anchors-materios `Signer`, receipt-call `signPayload`, MCP tools, CLI, units, conformance skeleton; the S1-8 soak starts once http plus replay is green.

**Slice 1b (days 8–13):** `cardano-tx-reader`, signTx mapping, `BrokerSigner`, ChainSource, approval verifier, issuance script; the real-YubiKey vector is captured on day 8.

- **S1-1 Isolation.** `orynq-agent`, a non-sudo operator stand-in and `orynq-broker` each try X's state, vault and `/proc`, ptrace, `systemd-creds decrypt` and `sudo -u orynq-sealed`: EACCES/EPERM, an audit row and a lockout each. NOPASSWD sudo or docker membership fails the gate. B's memory holds no private key.
- **S1-2 Decoded.** Generated Conway transactions cover every body key and flag (19–22 out of mandate), duplicates, indefinite lengths, trailing bytes, splices, aux mismatch, missing TTL, Byron and pointer addresses; witnesses re-decode; bodyHashes equal CSL's.
- **S1-3 Never a hash.** Fuzzed params reach `sign()` only through `verifyRelease`.
- **S1-4 Adversarial.** Transactions paying a denylisted counterparty hit the denylist and are out of mandate without it, as is a preprod transaction carrying a certificate; these, forged or replayed assertions, service aliases, sudo SSH targets, `POST /user/keys`, runner tokens and the header and path vectors fail without a decrypt. A planted token locks the session; a canary pages; parallel refusals lock at exactly three.
- **S1-5 No leak.** Canaries appear in no response, error, row, log, receipt, dump or B memory image, in any v1 encoding.
- **S1-6 Crash.** `kill -9` at every B and X boundary doubles no HTTP call; single-key re-signs are identical; revocation during downtime expires the intent.
- **S1-7 Receipts.** `callBound` under pinned X keys; a drained head certifies on Materios preprod via an X-signed extrinsic; a rewritten row fails verify.
- **S1-8 Runtime.** The drain's blob-gateway key runs under a service mandate for 48 h.
- **S1-9 Mandate.** Virtual and real-YubiKey issuance work; bad rpId, UV, signCount, principal, tier or members, and unsigned widening, are refused; parallel T1 mandates and supersede chains stop at the ceiling; revocation expires in-flight intents; a wrong domain gets -32011; two sessions share one cap exactly.
- **S1-10 Release gate.** A client playing a compromised B sends X forged ALLOWs for off-list counterparties, false priorSpent, stale or forked heads, replays, reordered atoms, out-of-tolerance clocks, foreign steps, a changed bodyHash and a partially denied intent, and drops a revocation: all refused with zero decrypts and zero spend; honest controls pass.
- **S1-11 Parity.** X's replay, B's guard and conduct's `guard-vectors.json` agree.

**Slice 2 (weeks 2–3):** W acknowledgements, approval page, push, revocation head; B-m and substrate signing; anchor-worker, cert-daemon; ssh; RFC 9421 at FPS services. Accepted when v1 criteria pass, old internal tokens and replayed signatures get 401, and verifiers refuse within 10 min of W ceasing revocation heads.

**Slice 3 (weeks 4–6):** an FPS 3-of-5 committee under the roster rule (script treasury, FROST known-authors root); `replay+zk-shadow` once gates 1–5 hold; Windows, DEX keepers, CI and remaining tokens; proxy mode, phone approver. Accepted when B plus t−1 compromised test holders cannot sign an over-cap or out-of-mandate preprod transaction, B can neither fork a mandate nor learn a share, equivocation yields an attribution record, lagging holders sync only certified steps, both OSes pass conformance, and the detector sweep is empty.

**Slice 4:** `zk+replay`, external `zk`-only holders, membership credentials, zkTLS, ledger-9 credentials. Accepted when an external holder co-signs a preprod payment without the mandate CBOR, a service authenticates with no stored secret and rejects a revoked credential in bound, and a requestHash-bound TLSNotary attestation of a source-host API call verifies offline with no token in any artifact.

## 16. Windows contract changes

Protocol, hashes, journal and receipts match Linux; one conformance suite drives both. Agents run only in WSL2. Windows runs replay only, holds no shares, and has no Z or B-m.

- **(a) Services.** `NT SERVICE\orynq-broker` holds no key; `NT SERVICE\orynq-sealed` owns `C:\ProgramData\orynq-sealed` (DACL: SYSTEM and its SID), with X's identity wrapped by a non-exportable Platform Crypto Provider key. Non-admins cannot stop or reconfigure either.
- **(b) Transport.** libuv sets no SDDL and exposes neither pipe handles nor AF_HYPERV, so a small Rust front end (tokio `named_pipe`, windows-rs) owns transport and passes `(connId, principal, frame)` to its Node parent over stdio. It does length framing only; strict JSON and dCBOR parsing stay in `packages/broker`. It serves three endpoints:
- **B's pipe.** Created with `first_pipe_instance` and `reject_remote_clients`. The server builds the DACL itself: the owner is its own SID; SYSTEM and the service get full access; admitted SIDs get `FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE` (0x120083), never 0x4 (`FILE_CREATE_PIPE_INSTANCE`).
  - Caller identity: `ImpersonateNamedPipeClient` → `OpenThreadToken`, which yields the SID, logon LUID, session and integrity level, then `RevertToSelf`; abort on failure. A client connecting at anonymous level gets `PEER_UNKNOWN`. The client pid is grade H only.
  - Clients open with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`. Before sending a byte, they require the pipe owner (or the token SID of the server process) to be the pinned service SID.
- **An `orynq-sealed` pipe** admitting only B's SID.
- **An hvsocket listener** (service-GUID registration) for the WSL2 relay.

The built-in `ssh-agent` stays disabled.
- **(c) Approvals.** Hello uses the WebAuthn platform authenticator via `webauthn.dll` (ES256, `tpm` attestation). It counts at T1 only with a key TPM-attested at a T2 enrollment and no agent running as the interactive user; never T2 or Tier-A.
- **(d) Lockout.** Deny ACEs on `C:\Users\<operator>`, browser profiles and wallet stores, plus a 4663 SACL tripwire.
- **(e) Clients.** `install-mcp.ps1` writes only the pipe name.
- **WSL2** is one principal, `agent-vm`: one live session per VM, refused while more than one distro exists, relay authenticated over AF_HYPERV with an in-distro key, `SO_PEERCRED` inside as grade H, automount and interop off.
- **Gate.** A Windows host runs test aliases only until it has been reinstalled from clean media under this contract.

## 17. Residual risks

1. Root, Admin, an X RCE or a compromised X dependency (age-encryption, @noble/*, @simplewebauthn/server, CSL, ssh2, koffi, the RFC 9421 library; from slice 4 zkir-v2 and TLSNotary) exposes that host's Tier-B secrets.
2. In-mandate misuse and exfiltration; W (and B until members are recomputed) in the display TCB.
3. A decoder bug or lying chain source fools one verifier.
4. Whole Midnight seeds and author secrets in B-m during jobs, the credential issuer gate included.
5. Unaudited circuits, a prototype ABI, unpinned params, an unmeasured prover.
6. t colluding holders; one operator until externals join.
7. Unanchored journal testimony (≤ 10 min), fd passing, unprofiled hosts, and W, Materios or committee outages.
8. Third parties hold our tokens; `matra_` keys stay bearer during their window.

## Appendix A. Review dispositions

v1 dispositions R1-1…R1-32 and R2-1…R2-31 stand, except: **R1-17** fees count inside the lovelace cap; **R1-22/R2-22** one pending approval per session covers issuance and out-of-mandate intents; **T0** becomes in-mandate release; **`http.grant`** becomes call-metered mandates; **conduct 0.2 gating** becomes slice-4 evidence. **D-1** (operator decision) removes approvals as the gate (§0, §3, §4, §12). **D-2** (honesty bounds) shapes §1 and §17.

**R3 (adversarial) and R4 (feasibility) reviews of the v2 draft:** every finding accepted. Fixes: executor domains, members, signing-surface recomputation, tier ledger, B-independent revocation (§3); staged intents, dual heads, D12 clock, ZK gates, encoding epoch, WASM prover (§4); keyless B, X-signed receipts and drain (§5, §11); DKG transport, nonces, roster, quorum certificates (§8); RFC 9421 profile, credential revocation (§9); zkTLS grading (§10); approval path, passkeys, windows (§12); timeline (§15); Windows (§16). R4's latency finding is met differently: X-domain mandates stay on replay.