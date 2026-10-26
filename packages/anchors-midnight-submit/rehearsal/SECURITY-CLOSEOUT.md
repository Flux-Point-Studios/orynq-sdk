# Rehearsal closeout acceptance

These are code and offline evidence checks. No live transaction, real wallet, project credential
or production signing seed was loaded during this closeout. Tests load only synthetic seeds.

| Issue | Acceptance item | Implementation and focused coverage |
|---|---|---|
| #105 | Committed source and per-phase provenance | `tooling.ts`, `source-runtime.ts`, phase/crash/signing/bundle commit fields; dirty-source, wrong-revision and preload regression tests. The verifier/composer reject stale or mixed evidence. |
| #105 | Actual refusal and tarball identity | Publish raw node refusal fields; exact code/message guard, tarball SHA-256/SHA-512 and installed file-tree binding. |
| #105 | Funding/same-block recovery | Preserve first funding, completed rounds and successful sides; release the barrier when a peer returns without sending. Focused multi-process restart tests. |
| #105 | Crash reset | Gate pins each label's precise kill mode and same bytes; runbook preserves partial-drill evidence/journals and requires a fresh namespace for a fresh drill. |
| #105 | Counts, pair and rotation truth | Distinct transaction counts, supported kinds, verified same-block hashes/heights and authenticated rotation chronology. Adverse gate cases reject mismatches. |
| #105 | Maintenance provenance and absence | Save and decode refused bytes, recompute hash, bind exact update/address/signature shape; require actual Blockfrost operator, exact refusal and separate-process absence queries. |
| #106 | Installed code and preloads | Exact tarball/installed files, unsafe archive and symlink refusal; reject `execArgv`/`NODE_OPTIONS`, strip inherited options in launchers. Mutated installed code and import-hook attacks fail. |
| #106 | Actual knownAuthors consumer | Feed each forgery to both document opening and policy consumption; coherent mutant consumer bypass fails the gate. |
| #106 | Truthful network, pins and purpose | Both read paths must identify preprod; derive active installed pins and packed verifier-key hashes; scope purpose to recorded writes. |
| #106 | Recheck cheap evidence | Composer reopens signed policies, reconstructs forgery documents, requires non-null commitments and checks saved tarball identity plus exact refused transactions. |
| #106 | Interrupted negative and privacy scan | Missing absence queries resume without rebroadcast, with a specific missing-check error; encoded eight-byte source windows avoid four-byte hex coincidences. |
| #109 | Credential privacy and operator wording | Scan project-id suffix/full ID and both mnemonic entropies; require recorded Blockfrost operator; disclose that separate processes using Blockfrost are not independent providers. |
| #109 | Shared endpoint and resumed metrics | Golden recorder imports shared source; missing deploy timings/balances are explicit absent-by-resume objects. |
| #109 | Resumed wallet revert | The production wallet tracks only locally balanced unsent transactions; submitter tests cover refusal of resumed bytes without reverting an unknown transaction. |
| #109 | Credential-free preprod write | Opt-in same-socket chain/genesis/runtime-pinned public WebSocket submission; positive delivery, wrong pins, exact refusal, malformed response and timeout tests. |
| #99 / integration | Guarded drill signing | Author-only drafts require an externally reviewed SHA-256 map and the guarded signing CLI. Consensus checkpoints come only from a separate shipped-root-approved policy, never a test fixture or fresh drill root. |

Live prerequisites remain explicit: operator-funded preprod wallets and local ZK material;
reviewed shipped-root-signed preprod author/checkpoint onboarding preserving existing checkpoint
history; operator review of the three author-only draft hashes; then actual rehearsal and packed
consumer verification. The default final evidence and maintenance-refusal claims require a
Blockfrost project id. Public WebSocket positive phases do not manufacture Blockfrost refusal
evidence. Missing live evidence fails closed and is not represented by synthetic test output.
