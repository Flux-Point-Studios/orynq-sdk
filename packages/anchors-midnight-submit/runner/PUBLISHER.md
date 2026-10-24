# Retained publication before confirmation

`publishCensusPlan(state, {network, targets})` publishes the active plan's exact
member and recovery-mapping bytes to two retained proof stores. Members precede
the plan. Each object is acknowledged in the census journal only after both
stores return bytes with the expected SHA-256. A successful PUT is insufficient.

Every invocation reads all objects, including previously acknowledged objects.
An HTTP error, missing post-upload object, incorrect digest, oversized readback
or redirect stops publication. Retry preserves the durable plan and exact bytes;
an existing correct object is read without another PUT. Public reads carry no
writer credential. Requests use the patched external HTTP client, refuse
redirects, allow at most 15 seconds per request, and limit every readback to the core
snapshot byte budget. Up to four members publish concurrently, with both copies
checked concurrently; every member finishes before the recovery plan starts.
The overall deadline scales with these bounded groups (at most 13 minutes
15 seconds for 64 members). A failed request aborts sibling requests, and every
started request settles before the invocation returns.

Each target supplies an HTTPS base URL and an enabled gateway API key authorized
for this network. URL userinfo, query strings and fragments are refused. Targets
must have distinct origins and hostnames. Mainnet requires HTTPS DNS hostnames and rejects literal IP addresses,
`localhost` and its subdomains. Hostnames are normalized
before distinctness checks, including trailing-dot aliases. HTTP and same-host
different-port targets are allowed only on preprod loopback for local rehearsals.

Distinct DNS names do not establish independent storage. Before activation, the
operator must provision a persistent copy outside the runner's restore domain
and document its backup/restore ownership. The gateway's retained object API
bypasses ordinary blob TTL and certification hooks. Publication trusts those
operators to retain bytes; it does not authenticate chain state or establish
Midnight coverage.

The caller must stop before confirmation or broadcast when publication fails.
After publication it must obtain a fresh census and use the existing state
confirmation checks. An authenticated durable follower, transaction-byte TTL
checks, fee accounting and the standing controller remain separate requirements.
This module neither loads wallet keys nor broadcasts transactions.
