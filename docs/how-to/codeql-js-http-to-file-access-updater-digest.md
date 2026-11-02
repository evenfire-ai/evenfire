# CodeQL `js/http-to-file-access` — updater release digest metadata

This document records the disposition of updater alert #1893 for PR #1190. The reported flow is
release metadata's SHA-256 digest into the updater operation journal. It is bounded metadata, not an
arbitrary network payload or network-selected file path.

## Verified flow and controls

- `desktopUpdateArtifacts.ts` selects the exact version/platform/architecture asset, requires the
  expected GitHub download URL, bounded size, and a `sha256:<64 hex>` digest, then normalizes the
  digest to lowercase.
- `downloadVerifiedReleaseAsset` hashes the received bytes and rejects them unless the computed
  digest matches the selected asset digest.
- The manager persists the verified digest as `assetSha256` for later package-integrity checks.
  Journal validation accepts only a 64-character lowercase hexadecimal value.
- The journal destination is an updater-owned operation path. It is written through a random
  exclusive temporary filename with mode `0600`, then atomically renamed. Network data never
  controls the destination path or supplies arbitrary file contents.
- R3-M2 remains closed: the raw backend release identity is not persisted or used as a target
  identity. This alert's dataflow is the separately validated asset digest.

## Disposition

The CodeQL flow is real, but the rule's arbitrary-file-write risk does not apply to this bounded
digest field and fixed updater journal destination. Alert #1893 is an individual false-positive
disposition; do not disable or filter `js/http-to-file-access` globally. Reassess if digest
validation, downloaded-byte verification, operation-journal validation, or updater path ownership
changes.
