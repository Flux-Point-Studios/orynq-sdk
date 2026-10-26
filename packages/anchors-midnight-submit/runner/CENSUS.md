# Finalized Materios census

`readCensus({rpcUrl, genesis, signal?})` reads receipt storage directly at one
reported finalized block. It uses the runtime's `OrinqReceipts.Receipts` prefix
and validates each Blake2_128Concat key before decoding the exact SCALE record.
Every run enumerates all keys again so later certification is observed.

The result distinguishes certified, uncertified, pending and contradicted entries.
Missing or undecodable values remain pending. A nonzero certificate hash that
does not match an allowed encoding is contradicted. Neither state establishes
coverage. Callers must retain these states and retry them on the next census.

Requests use an explicit genesis and endpoint, a named User-Agent, patched Undici,
256-key pages, a 16MiB decoded-response limit, a 262144-receipt limit, a 90-second run
deadline and a 15-second request deadline. Enumeration ends only on an empty page.
Any transport, pagination or envelope failure rejects the entire run.

This is an observed census of the configured Materios RPC. It does not authenticate
the RPC's finality claims or prove complete storage enumeration against a hostile
server. The coverage watch must independently obtain its own census and finality
evidence rather than certifying the runner's saved counts.

The reader neither loads a wallet nor prepares or broadcasts transactions. The
standing planner must persist snapshots, plans and exclusive claims before using
the result. It must revalidate members before confirmation and retain historical
claims across restore and certificate changes.
