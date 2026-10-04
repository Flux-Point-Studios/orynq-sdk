---
"@fluxpointstudios/orynq-sdk-payer-cardano-cip30": minor
---

Add the 1AM wallet (`window.cardano["1am"]`) to `WalletName`, `KNOWN_WALLETS`
and `WALLET_DISPLAY_NAMES`, so `getAvailableWallets()` detects it and it can be
connected by name.
