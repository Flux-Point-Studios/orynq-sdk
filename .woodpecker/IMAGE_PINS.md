# CI image identities

CI, release packing and the anchor-worker workflow use immutable OCI image digests. The human-readable tags identify the selected release line; the digest determines the actual contents. The existing credential-bearing publisher and OCI-index plugin digests are unchanged.

The public registry manifests were resolved on 2026-10-26, and every selected index includes `linux/amd64`, matching these pipelines. When updating an image, resolve and review the new registry digest explicitly, retain the tag for context, and rerun that image's pipeline. Avoid changing a digest during a release retry.
