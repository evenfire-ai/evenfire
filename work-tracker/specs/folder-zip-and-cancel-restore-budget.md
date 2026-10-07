# Folder-zip export and cancel-restore budget

Scope: the Desktop "Download as zip" walk (`desktop-app/ui/src/lib/gfsFolderZip.ts`,
`zipWriter.ts`, Files view wiring) and the STORY-38 cancel-restore path
(`useComposerAttachments.ts`, `useAgentChatController.ts`). This spec is the
design pass those files owed before their fix-commit churn; every behavioral
rule below is enforced by a named test.

## ZIP budget model (memory, entries, paths)

**One budget, four accounting points.** The walk's byte ceiling
(`GFS_ZIP_MAX_TOTAL_BYTES`, 512 MiB) bounds the _sum_ of what the archive can
hold. It is enforced at every point where bytes could previously escape it:

| Accounting point        | Rule                                                                                                                                                                                                                       | Enforcement                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Planning (listing)      | Declared child sizes sum to the ceiling; missing/unusable sizes count 0, never NaN                                                                                                                                         | cumulative check per discovered file |
| Transfer (per download) | `runningActual + incoming ≤ ceiling` must hold _producer-side_: each download carries `maxBytes = ceiling − runningActual + 1`; the bounded fetch rejects (413) before an over-budget body is materialized in the renderer | 413 maps to the same limit refusal   |
| Receipt                 | Actual buffer length re-checked before it enters the archive buffer                                                                                                                                                        | hard backstop                        |
| Archive + save          | One pre-sized single buffer (planned bytes + header overhead); `build()` returns a view; the anchor-save Blob is the one unavoidable copy                                                                                  | streaming writer contract            |

**Peak renderer memory** under this model is `archive buffer (≤ 512 MiB) + one
in-flight download buffer (≤ remaining budget) + save-time Blob copy
(≤ 512 MiB)` ≈ **1.1 GiB worst case at the ceiling**, typically far less. A
file-backed streamed save via the main process was evaluated and deferred: it
needs a new streamed IPC channel and a save-dialog flow; the capped,
producer-bounded model above is the defensible bound for this PR and is what
the tests pin.

**Entry counting includes directories.** `GFS_ZIP_MAX_ENTRIES` (2000) counts
every accepted child — files _and_ folders — because both cost walk work
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
the GFS client fetch, so a Stop ends the _producer's_ work, not just the
renderer's patience. The walk passes its job signal to every producer call,
initial and retried. One job per Files page instance; unmount aborts; a
replacement job cannot start until the previous walk settles (the handler's
`finally` owns the job ref).

**Binding.** Cancel-restore and its Discard-all action are bound to BOTH the
originating agent AND the originating chat (the retained snapshot's `chatId`).
Composer attachment _state_ is per-agent and shared across that agent's chats,
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

## Round-2 extensions

### Cancellation settling after a chat switch: PRESERVATION

Round 1 made a skipped restore release the retained snapshot, which turned a
context switch into data loss: cancel in chat A, answer lands while chat B is
viewed → A's attachments were gone forever. The invariant is STORY-38's — the
kept attachments must survive within the session. Decision:

| When the cancel answer (or 404) lands     | Behavior                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Originating agent AND chat still active   | Restore now (atomic merge), toast bound to that agent+chat                                                                                                                                                                                                                             |
| Different agent or chat active            | PARK the restoration (images with regenerated preview URLs + references) under the `(agentRef, chatId)` identity, then release the task snapshot. The parked payload lives in memory only, with the same lifetime as composer state (cleared per agent switch/logout, never persisted) |
| The originating chat becomes active again | Apply the parked restoration through the same atomic merge (caps reported), show the kept-attachments toast bound to that agent+chat                                                                                                                                                   |

The Discard-all binding is unchanged: agent AND chat. Parking replaces the
round-1 "release and lose" row above wherever they conflict.

### Exact download-budget exhaustion

The per-transfer bound must never produce an invalid request:

| Walk state                                                                 | Behavior                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remaining = ceiling − runningActual` is 0 (or negative) before a transfer | Stop before the next IPC call — `maxBytes` is never sent as 0 or negative. Un-downloaded files are reported as skips with reason "Zip byte limit reached" and the archive finishes cleanly with what it holds |
| A transfer is refused producer-side (413) mid-walk                         | Skip that file with the same visible reason and continue; subsequent files hit the remaining-0 rule, so the walk always terminates with a saved, valid archive plus per-file notices                          |
| Declared sizes exceed the ceiling at planning                              | Refuse before any transfer (unchanged)                                                                                                                                                                        |

### Final archive name length after collision handling

Length validation runs on the FINAL committed name — after case-insensitive
collision suffixing — at the point of commitment, not on the pre-collision
path. The walk finalizes names (fold-aware dedupe + ` (n)` suffix) and
validates the finished encoded name against the 65535-byte ZIP field bound
before sending it to the writer; a name that only overflows after suffixing is
skipped with the visible "Path too long" notice. The main-process writer
re-validates every received name before writing headers (defense in depth: it
never writes a name whose encoded length would truncate a 16-bit field).

### Memory model: streamed, file-backed assembly

The in-renderer archive buffer is replaced by a streamed main-process save:

- The renderer downloads one file at a time (strictly sequential transfers)
  and hands each entry to `zipStream:append`; it retains no archive bytes.
- The main process appends each entry's local header + payload to a temp file,
  keeping only central-directory metadata in memory (~76 + name bytes per
  entry), then finalizes (central directory + EOCD appended in place) and
  moves the temp file to the user-chosen save location (`zipStream:finish`,
  save dialog; `zipStream:abort` deletes the temp file).
- Peak memory: renderer = one in-flight transfer (bounded by the remaining
  budget, ≤ the 512 MiB ceiling) + its transient IPC copy; main = directory
  metadata + one chunk; disk = the temp archive (≤ ceiling + per-entry
  overhead). Peak renderer memory is independent of folder size.
- The 512 MiB total ceiling and all four accounting points (planning,
  per-transfer producer bound, receipt, finish) are unchanged; the save path
  no longer contributes a full-size Blob copy.
