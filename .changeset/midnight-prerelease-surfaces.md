---
"@fluxpointstudios/orynq-mcp": minor
"@fluxpointstudios/orynq-sdk-quickstart": minor
---

Add the read-only `verify_midnight_anchor` MCP tool and the `orynq verify midnight`, `orynq keys init midnight`, and `orynq anchor midnight` CLI commands. These prerelease surfaces require the optional anchors-midnight peer, which remains private and unavailable on npm until the D-10 release gate opens. Use a built orynq-sdk source checkout as documented in each package README; npm-only installs report this requirement without breaking other tools or commands. No Midnight submitter is published.

Keep private Midnight minor releases from forcing major releases of MCP and quickstart.
