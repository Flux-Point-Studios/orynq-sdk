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
`decodeOpenPayload(bytes)` reads an OPEN payload: the literal bytes `null`
for a client the frontend could not identify, otherwise one peer as strict
JSON. Refusals throw `BrokerWireError` naming the field, never quoting it.
