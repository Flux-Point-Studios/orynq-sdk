---
"@fluxpointstudios/orynq-sdk-quickstart": patch
---

`orynq verify midnight --hidden` and `orynq anchor midnight --hidden` take the
attribute from the model manifest hash the bundle's root commits to
(`privateRun.modelManifestHash`), not from the unhashed top-level copy, and
refuse a bundle whose top-level copy differs.
