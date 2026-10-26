# Folder-zip export and cancel-restore budget

Scope: the Desktop "Download as zip" walk (`desktop-app/ui/src/lib/gfsFolderZip.ts`,
`desktop-app/src/gfs/zipStream.ts`, Files view wiring) and the STORY-38
cancel-restore path (`useComposerAttachments.ts`, `useAgentChatController.ts`).
This spec is the design pass those files owed before their fix-commit churn;
every behavioral rule below is enforced by a named test.

## ZIP budget model (memory, entries, paths)

**One budget, four accounting points.** The walk's byte ceiling
(`GFS_ZIP_MAX_TOTAL_BYTES`, 512 MiB) bounds the _sum_ of what the archive can
hold. It is enforced at every point where bytes could previously escape it:

| Accounting point        | Rule                                                                                                                                                                                                            | Enforcement                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Planning (listing)      | Declared child sizes sum to the ceiling; missing/unusable sizes count 0, never NaN                                                                                                                              | cumulative check per discovered file |
| Transfer (per download) | `runningActual + incoming ≤ ceiling` must hold _producer-side_: each transfer carries `maxBytes = ceiling − runningActual`; the bounded fetch rejects (413) before an over-budget body is materialized anywhere | 413 maps to the same limit refusal   |
| Receipt                 | Actual byte count re-checked before the entry is committed to the archive                                                                                                                                       | hard backstop                        |
| Archive + save          | One entry at a time, appended to a main-process temp file; the central directory is the only in-memory metadata                                                                                                 | streaming writer contract            |

**Peak memory.** The MAIN process fetches each transfer and writes it into the
archive **chunk by chunk** (`gfs:zipStream:appendFromUri` → `streamBoundedBytes`
→ the ZIP writer's sink). The payload therefore never crosses the IPC
boundary and never materializes as one buffer in either process:

- renderer: **zero** payload bytes — it hands over a name, a URI and a bound;
- main: one chunk at a time, plus the central directory (~76 + name bytes per
  entry);
- disk: the temp archive (≤ ceiling + per-entry overhead).

This replaces the round-2 "one in-flight transfer in the renderer" model, which
held the collected chunks AND a contiguous copy of them at the same time (≈ 1
GiB of payload allocation at the 512 MiB ceiling) before the IPC copy.

**Entry counting includes directories.** `GFS_ZIP_MAX_ENTRIES` (2000) counts
every accepted child — files _and_ folders — because both cost walk work
(listing requests). The refusal message says "files and folders".

**Complete encoded path bound.** A ZIP name field is a 16-bit byte count, so
an entry's full encoded path must stay under 65535 bytes. Segments are capped
at 1024 UTF-8 bytes (whole code points); the assembled path is checked before
enqueue/add — an overlong file is skipped with a "Path too long" notice and an
overlong DIRECTORY prunes its subtree (all descendants would overflow too).

**Name collisions.** Deduplication is case-insensitive across the whole entry
name: `Report.txt` and `report.txt` cannot both be written, because portable
case-insensitive extractors would silently overwrite one. The second colliding
name receives the ` (2)` suffix. Portable extraction IS a product requirement;
the skip-notice path shown to the user may differ from the archived
de-duplicated name (accepted divergence, noted in the result copy).

**Path COMPONENT conflicts (R3-M5).** Full-name de-duplication is not enough:
an entry name is a path, and every extractor materializes each component as a
real directory. A file named `report` and a directory `Report/` therefore
collide on a case-insensitive filesystem even though their full names differ.

The allocator (`desktop-app/src/gfs/zipEntryName.ts`) reserves two mutually
exclusive namespaces per archive:

- the full path of every committed file;
- every directory path the committed files imply, mapped to the path actually
  written.

A path may be reserved as a file OR as a directory, never both. A file whose
path is already a directory is renamed (`report` → `report (2)`); a directory
whose path is already a file is renamed (`Report` → `Report (2)`). The walk
reserves the implied directory paths BEFORE it allocates any file name, so the
outcome does not depend on the order the listing happened to return the
entries in, and the file is always the one that gives way.

**Windows device names.** `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and
`LPT1`–`LPT9` are the console device on Windows, not file names — `CON.txt` is
reserved too, because the extension does not make it safe. Desktop ships a
Windows build, so the policy is: the renderer escapes such a segment with a
`_` prefix (`CON` → `_CON`), and the main process REFUSES such a name.

**Producer fixtures.** Wire-shaped test fixtures for GFS children derive from
`ui/src/gfs/__fixtures__/gfsProducerFixtures.ts` (`childView`), never from
hand-rolled literals; merge/dedupe/caps/path-normalization additionally carry
property-based invariants (fast-check).

## The main process is the trust boundary (R3-M1, R3-M2, R3-M3)

The renderer is a web page in an Electron window. Everything below is enforced
in MAIN, independently of the renderer, and is covered through the real IPC
handlers:

**Path safety (R3-M1).** Every entry name is validated as a canonical
relative path BEFORE a byte of entry data is written. A name is refused when
it is empty, holds a control character, holds a backslash, is rooted (`/x`),
is drive-qualified (`C:\x`), holds an empty path segment, holds a `.`/`..`
segment, holds a character Windows forbids (`: * ? " < > |`), ends a segment
with a dot or a space, or names a reserved Windows device.

**Resource limits (R3-M2).** The main process enforces the aggregate payload
ceiling, the entry-count ceiling, the ZIP32 format bounds (65535 entries,
4 GiB − 1 bytes) and the concurrency bounds (8 open archives, 2 per window, 4
in-flight appends per job). A rejected append changes NOTHING: not the temp
file's size, not the entry list, not the byte counters.

**Job ownership (R3-M2).** A job is opened by one window and may only be
driven by that window: another window cannot append to, finish or abort it.

**Cleanup ownership (R3-M3).** The job owns its file handle and its temp file
until the save has COMPLETED. Every unsuccessful path — a failed write, a
failed close, a failed save dialog, a failed rename, a failed copy fallback —
closes the handle and removes the `.part` file. A half-written entry is rolled
back (the temp file is truncated to the entry's first byte) so the archive
stays a valid sequence of complete entries; a failed rollback destroys the
job instead of leaving an unowned resource behind.

## Cancellation

**Producer-side propagation.** `window.clerum.gfs.listChildren`,
`window.clerum.gfs.download` and `window.clerum.gfs.zipStream.appendFromUri`
accept an optional `AbortSignal`. The preload bridge attaches a per-call
`requestId`; on abort it fires `gfs:abort`; the main process holds one
`AbortController` per in-flight requestId and threads it into the GFS client
fetch, so a Stop ends the _producer's_ work, not just the renderer's patience.
The walk passes its job signal to every producer call, initial and retried.
One job per Files page instance; unmount aborts; a replacement job cannot start
until the previous walk settles (the handler's `finally` owns the job ref).

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

| When the cancel answer (or 404) lands     | Behavior                                                                                                                                                                                                                                                                               | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Originating agent AND chat still active   | Restore now (atomic merge), toast bound to that agent+chat                                                                                                                                                                                                                             | one merge, one toast                                                                                                                                                                                                                                                                   |
| Different agent or chat active            | PARK the restoration (images with regenerated preview URLs + references) under the `(agentRef, chatId)` identity, then release the task snapshot. The parked payload lives in memory only, with the same lifetime as composer state (cleared per agent switch/logout, never persisted) | a QUEUE of batches, one per cancellation                                                                                                                                                                                                                                               |
| The originating chat becomes active again | Apply the parked restoration through the same atomic merge (caps reported), show the kept-attachments toast bound to that agent+chat                                                                                                                                                   | EVERY batch, in the order the cancellations settled                                                                                                                                                                                                                                    |

The Discard-all binding is unchanged: agent AND chat. Parking replaces the
round-1 "release and lose" row above wherever they conflict.

**Two cancellations, one chat (R3-M4).** Two distinct cancellations can settle
for the SAME originating chat while the user views another chat. The parked
value is therefore a QUEUE, not a single batch: the later batch must not
overwrite the earlier one's attachments. Each batch keeps its own attachments,
its own cap accounting and its own toast, and the batches apply in the order
they settled — in either settlement order.

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

- The renderer walks the folder and hands each entry to the main process as a
  NAME and a URI. It retains no archive bytes and no payload bytes.
- The main process resolves the resource, fetches it through the brokered
  proxy with a producer-side ceiling, and writes each response chunk into the
  archive's temp file as it arrives, folding every chunk into the running
  CRC-32. The entry's local header is written first with placeholder CRC/size
  fields and patched in place once the payload is complete, so the entry stays
  a valid STORED entry.
- Only the central-directory metadata stays in memory (~76 + name bytes per
  entry); `finish` appends the directory + EOCD in place and moves the temp
  file to the user-chosen save location (`zipStream:finish`, save dialog;
  `zipStream:abort` deletes the temp file).
- Peak memory: renderer = 0 payload bytes; main = one chunk + directory
  metadata; disk = the temp archive (≤ ceiling + per-entry overhead). Peak
  memory is independent of folder size, in BOTH processes.

## Regression proofs (R1-M6)

Every regression test must fail as an ASSERTION against the exact head that
carried the bug — never as a timeout, and never as an error thrown before the
first expectation.

| Finding                                        | Proof                                                                               | Buggy head  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| R2-L1 (cap-time duplicate counted as a drop)   | property example: a cap-time duplicate reports `duplicates`, never `dropped`        | `53659bfa4` |
| R2-M1 (parked cancel-restoration)              | controller example: returning to the originating chat restores the kept attachments | `999002762` |
| R2-L2 (exact budget exhaustion)                | walk example: the transfer behind the exhausted budget is never requested           | `92da7b21a` |
| R2-L3 (no producer work for an aborted signal) | preload example: an already-aborted signal starts no invoke and no abort            | `4970a551e` |

- The property suite runs TENS OF THOUSANDS of cases (25 000 per property) and
  starts from VALID composer states, so the invariants are provable against
  states production can hold.
- The preload example bounds its wait: a bridge that hangs fails with
  "the bridge did not reject", not with a 30-second timeout.
- The walk example CAPTURES the outcome, so a walk that throws fails with
  "the walk did not finish cleanly", not with an unhandled rejection.
