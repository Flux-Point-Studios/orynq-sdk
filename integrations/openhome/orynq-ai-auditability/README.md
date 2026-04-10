# Orynq AI Auditability

![Community](https://img.shields.io/badge/OpenHome-Community-orange?style=flat-square)
![Author](https://img.shields.io/badge/Author-@FluxPointStudios-lightgrey?style=flat-square)

## What It Does

Creates tamper-proof, blockchain-anchored audit trails for AI conversations using [Orynq's](https://github.com/flux-point-studios/orynq-sdk) Proof-of-Inference (PoI) protocol. Each audit record is cryptographically hashed and anchored to the Cardano blockchain, making it independently verifiable and impossible to alter after the fact.

## Suggested Trigger Words

- "audit my AI"
- "create audit trail"
- "audit this conversation"
- "make this auditable"
- "verify AI actions"

## Setup

1. Get an Orynq API key from [Flux Point Studios](https://fluxpointstudios.com)
2. Open `main.py` and replace `YOUR_ORYNQ_API_KEY_HERE` with your API key
3. Zip the ability folder and upload it to your OpenHome dashboard
4. Configure trigger words in the dashboard

## How It Works

1. User triggers the ability with a phrase like "audit this conversation"
2. The ability asks what the user wants to include in the audit record
3. A cryptographic process trace is built locally using SHA-256 rolling hash chains — each event is hashed and chained to the previous one, creating an immutable ordering proof
4. The trace manifest is submitted to the Orynq managed API, which anchors it to the Cardano blockchain (metadata label 2222)
5. The ability speaks back the verification hash so the user has a permanent, tamper-proof record

## Example Conversation

> **User:** "Audit this conversation"
>
> **AI:** "I'll create a tamper-proof audit trail for this conversation using Orynq. What would you like to include in the audit record?"
>
> **User:** "I asked the AI to review my contract and it recommended signing it"
>
> **AI:** "Building your cryptographic audit trail and anchoring it to the Cardano blockchain now."
>
> **AI:** "Your audit trail has been anchored to Cardano. The root hash ends in a3f8b2c1 and it's now independently verifiable on any block explorer."

## Why Auditability Matters

As AI agents take on more consequential tasks — financial advice, medical triage, legal analysis — there's a growing need to prove exactly what an AI said, when it said it, and in what order. Orynq's Proof-of-Inference protocol provides:

- **Tamper evidence**: Rolling hash chains make any alteration detectable
- **Blockchain anchoring**: Cardano L1 provides an immutable timestamp
- **Independent verification**: Anyone can verify an anchor using a tx hash — no trust in the AI provider required
- **Privacy preservation**: Only cryptographic hashes go on-chain; raw conversation data stays private

## Learn More

- [Orynq SDK on GitHub](https://github.com/flux-point-studios/orynq-sdk)
- [Cardano Metadata Label 2222](https://github.com/cardano-foundation/CIPs) — the on-chain anchor format
