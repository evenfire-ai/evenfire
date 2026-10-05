# Folder-zip export and cancel-restore budget

Scope: the Desktop "Download as zip" walk (`desktop-app/ui/src/lib/gfsFolderZip.ts`,
`zipWriter.ts`, Files view wiring) and the STORY-38 cancel-restore path
(`useComposerAttachments.ts`, `useAgentChatController.ts`). This spec is the
design pass those files owed before their fix-commit churn; every behavioral
rule below is enforced by a named test.

## ZIP budget model (memory, entries, paths)

**One budget, four accounting points.** The walk's byte ceiling
(`GFS_ZIP_MAX_TOTAL_BYTES`, 512 MiB) bounds the *sum* of what the archive can
hold. It is enforced at every point where bytes could previously escape it:

| Accounting point | Rule | Enforcement |
| --- | --- | --- |
| Planning (listing) | Declared child sizes sum to the ceiling; missing/unusable sizes count 0, never NaN | cumulative check per discovered file |
| Transfer (per download) | `runningActual + incoming ≤ ceiling` must hold *producer-side*: each download carries `maxBytes = ceiling − runningActual + 1`; the bounded fetch rejects (413) before an over-budget body is materialized in the renderer | 413 maps to the same limit refusal |
| Receipt | Actual buffer length re-checked before it enters the archive buffer | hard backstop |
| Archive + save | One pre-sized single buffer (planned bytes + header overhead); `build()` returns a view; the anchor-save Blob is the one unavoidable copy | streaming writer contract |

**Peak renderer memory** under this model is `archive buffer (≤ 512 MiB) + one
in-flight download buffer (≤ remaining budget) + save-time Blob copy
(≤ 512 MiB)` ≈ **1.1 GiB worst case at the ceiling**, typically far less. A
file-backed streamed save via the main process was evaluated and deferred: it
needs a new streamed IPC channel and a save-dialog flow; the capped,
producer-bounded model above is the defensible bound for this PR and is what
the tests pin.

**Entry counting includes directories.** `GFS_ZIP_MAX_ENTRIES` (2000) counts
every accepted child — files *and* folders — because both cost walk work
(listing requests). The refusal message says "files and folders".

**Complete encoded path bound.** A ZIP name field is a 16-bit byte count, so
an entry's full encoded path must stay under 65535 bytes. Segments are capped
at 1024 UTF-8 bytes (whole code points); the assembled path is checked before
enqueue/add — an overlong file is skipped with a "Path too long" notice and an
overlong directory prunes its subtree (all descendants would overflow too).

**Name collisions.** Deduplication is case-insensitive across the whole entry
name: `Report.txt` and `report.txt` cannot both be written, because portable
case-insensitive extractors would silently overwrite one. The second colliding
name receives the ` (2)` suffix. Portable extraction IS a product requirement;
the skip-notice path shown to the user may differ from the archived
de-duplicated name (accepted divergence, noted in the result copy).

**Producer fixtures.** Wire-shaped test fixtures for GFS children derive from
`ui/src/gfs/__fixtures__/gfsProducerFixtures.ts` (`childView`), never from
hand-rolled literals; merge/dedupe/caps/path-normalization additionally carry
property-based invariants (fast-check).

## Cancellation

**Producer-side propagation.** `window.clerum.gfs.listChildren` and
`window.clerum.gfs.download` accept an optional `AbortSignal`. The preload
bridge attaches a per-call `requestId`; on abort it fires `gfs:abort`; the main
process holds one `AbortController` per in-flight requestId and threads it into
the GFS client fetch, so a Stop ends the *producer's* work, not just the
renderer's patience. The walk passes its job signal to every producer call,
initial and retried. One job per Files page instance; unmount aborts; a
replacement job cannot start until the previous walk settles (the handler's
`finally` owns the job ref).

**Binding.** Cancel-restore and its Discard-all action are bound to BOTH the
originating agent AND the originating chat (the retained snapshot's `chatId`).
Composer attachment *state* is per-agent and shared across that agent's chats,
so the binding is a semantic guard, not a storage key: if the user has moved to
a different agent or a different chat by the time the cancel answer (or the
toast action) lands, the restore/action no-ops. A skipped restore still
releases the retained snapshot: a cancel is terminal by intent, and navigating
away mid-cancel deliberately abandons the courtesy restore.

## Restore semantics

**Atomic reconciliation.** The restore path performs ONE merge against ONE
live snapshot of composer state — the snapshot the attachment hook mirrors at
every committed transition (inside its state updaters), never a render
closure. The merged result and the drop counts are derived from that same
snapshot, so the toast can never report drops that disagree with the state the
user sees.

**Caps enforced during restoration, both kinds.** Images: the
20-image composer cap plus byte-identity dedupe. References: id-dedupe plus
the global `FILE_REFERENCE_MAX_COUNT` (10) cap — a restored set may not push
the composer past the send-time limit, because a restore that creates an
unsendable composer is not a restore. Overflow of either kind is reported in
the kept-attachments toast (kept/dropped counts per kind).
