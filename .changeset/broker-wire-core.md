---
"@fluxpointstudios/orynq-sdk-core": minor
---

New `/broker-wire` subpath: the contract between a credential broker and the
transport frontends that own its sockets and pipes.

`parsePeer(value)` accepts exactly one of two peer shapes and refuses any
unknown or missing key: `{os: "linux", uid, gid, pidHint, cgroup}` and
`{os: "windows", sid, logonLuid, tsSessionId, integrityRid, pidHint}`. uid,
gid, tsSessionId and integrityRid are u32 numbers, pidHint a u32 number or
null, cgroup an absolute cgroup v2 path of at most 4096 UTF-8 bytes, sid a
canonical user (`S-1-5-21-` plus four sub-authorities) or service
(`S-1-5-80-` plus five) SID, and logonLuid a canonical decimal u64 string.
`isAccountSid(value)` is that SID check on its own, for configuration.
`decodeOpenPayload(bytes)` reads an OPEN payload: the literal bytes `null`
for a client the frontend could not identify, otherwise one peer as strict
JSON. Refusals throw `BrokerWireError` naming the field, never quoting it.

The subpath also carries the stdio mux a broker and its frontend speak,
wire-identical to the shipped Windows sidecar: `u32 length | u8 kind |
u64 conn | payload`, big-endian, where length counts kind, conn and payload
(9 to 9 + 16 MiB, so a full 16 MiB payload fits). Kinds: `MUX_READY` (conn
0, no payload), `MUX_OPEN` (a peer or `null`), `MUX_FRAME` (1 byte to
16 MiB) and `MUX_CLOSE` (no payload). `encodeMuxMessage` writes one;
`MuxDecoder` reassembles them from arbitrary chunks, judges each header as
its bytes arrive so a bad length, kind or kind rule is refused from the
shortest prefix that shows it, and allocates a payload only as its bytes
arrive. Refusals are `BrokerWireError` with codes `MUX_LENGTH`, `MUX_KIND`,
`MUX_READY`, `MUX_FRAME` and `MUX_CLOSE`.
