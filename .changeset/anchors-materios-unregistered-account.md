---
"@fluxpointstudios/orynq-sdk-anchors-materios": minor
---

Tell an unregistered account apart from a MOTRA shortfall. `CheckNonce` refuses an account with no provider and no sufficient reference with `InvalidTransaction::Payment`, the code a fee shortfall also gets.

- A `1010` fee refusal on submission reads the signer's account and appends whether it is unregistered (register cMATRA on Cardano, or ask the Materios operator for capacity) or short of MOTRA. The new `feeShortfall` field carries `{ reason, account, providers, sufficients }`. The error stays `not-landed`, `cause` is still the node's refusal, and the message still begins with the node's text.
- `waitForMotra` now rejects at its timeout with `MateriosFeeError`, carrying the same `shortfall` plus `balance` and `minBalance`, instead of a plain `Error` that blamed MATRA holdings.
