# GFS large-file Host downloads

## Scope

MCP Host separates GFS source admission from visual model input:

- GFS admission defaults to **16 MiB** and can be raised to at most **200 MiB** only by an environment-approved deployment.
- Text at or below **8 KiB** may be returned inline.
- Larger admitted sources are transferred as governed workspace files. Their contents are not placed in the model conversation.
- Small binary and SVG sources also retain a workspace copy when that capability is available; only decoded plain text is returned inline.
- Visual projection is decided by the effective provider/model/transport profile after local validation. It never defines the generic GFS source limit.
- PR #806's expected Grok visual profile is not materialized in this execution base: its installed attempt contract does not export visual limits. Grok GFS pixels therefore fail closed until that contract lands; when it does, its values are a provider visual profile, not a GFS transfer ceiling. PR #932's 11 MiB inline-document boundary is a separate Desktop composer policy and is also not a GFS transfer ceiling.

This fixes the reported 3,836,961-byte CSV case: the file is admitted under 16 MiB and delivered to the caller workspace for approved local processing.

## Visual delivery profiles

The catalog must confirm image input, the implemented operation must serialize
images, and the actual provider instance must expose a matching transport profile.
SDK names and model names do not establish the endpoint. Official API profiles
require the effective HTTPS endpoint with its exact origin/path, no embedded
credentials, query or fragment, and the standard port. Compatible/custom
endpoints do not inherit an official profile.

| Transport           | Image bytes                                                                                 | Final serialized body                         | Count and geometry                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex subscription  | 16 MiB per image and total                                                                  | 24 MiB visual envelope; 8 MiB non-image share | 20 images; 2048 pixels per side; 4,194,304 pixels                                                                                                         |
| Official OpenAI API | No independent decoded-image bound is published; GFS admission and local memory still apply | 512 MB                                        | 1,500 images; model/detail processing rules still apply                                                                                                   |
| Direct Claude API   | 10 MB base64 per image, equivalent to at most 7,500,000 original bytes                      | 32 MB                                         | 100 images while authoritative model-window metadata is unavailable; 8000 pixels per side, reduced to 2000 when the final request has more than 20 images |

Published API MB values use decimal bytes here. Claude's documented 600-image
allowance is not inferred from the configured conversation limit or a model name.
The dimension threshold counts every image origin and is recalculated after
demotion. Sources:
[OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision),
[Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision), and
[Claude request limits](https://platform.claude.com/docs/en/api/errors).

The local visual budget remains 24 MiB of reads and 96 MiB of resident payloads
per turn. A large image is classified from a bounded prefix; its profile and raw
memory reservation are checked before loading the retained file. Validation
keeps its separate decoder memory and deadline controls. A source that cannot
be projected remains available as a workspace file with an explicit reason.
Every physical attempt, including cached calls and fallback, rechecks its own
profile and final body. Removing pixels updates both receipt delivery flags
without discarding the path, checksum, version or retained original.

## Effective limits

| Environment variable                       |    Default |     Ceiling | Meaning                                                            |
| ------------------------------------------ | ---------: | ----------: | ------------------------------------------------------------------ |
| `MCP_HOST_GFS_MAX_FILE_BYTES`              | `16777216` | `209715200` | Largest GFS source admitted by MCP Host.                           |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT`    |       `85` |       `100` | Retained download budget, as a percentage of the workspace volume. |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY` |        `1` |         `2` | Simultaneous active transfers per caller.                          |
| `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS`          |      `168` |      `8760` | Retention period for a completed copy.                             |

All values are parsed as positive decimal byte/percent/count/hour integers. Empty, zero, fractional, negative, exponent, padded, partial, non-integer, and above-ceiling values fail startup; the storage percent therefore accepts 1 to 100.

`MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`, `MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES` and `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES` were removed. The per-user byte and file limits were removed by user decision: a fixed byte budget did not follow the size of the workspace volume. A Host that still has any of them set starts normally, ignores it and logs one `warn` `GFS download store ignores a removed retained-storage variable; the budget is MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT of the workspace volume` per variable, naming the variable and never its value.

The supported end-to-end size is the minimum of the applicable Desktop/GFS upload limit, GFSC transport limits, MCP Host admission, workspace PVC capacity, download quotas, and provider-specific visual limits. Raising only MCP Host admission does not raise any other layer.

## Delivery behavior

For an admitted source above 8 KiB:

1. MCP Host obtains bounded metadata and validates identity, version, file kind, and size.
2. It streams the authorized `/content` response to a Host-managed `.gfs-downloads` directory under the caller workspace.
3. It verifies the exact byte count and SHA-256, publishes the file with private modes, and returns a receipt containing source metadata, version, size, checksum, expiry, and a path relative to that caller workspace.
4. The tool result instructs the model to use `shell_exec` for local processing, write outputs outside `.gfs-downloads`, and return only bounded counts, aggregates, errors, or samples.

Tool receipts and prepared references carry the same locally authored processing
instructions. The shell description advertises the actual Node executable and
the module resolver anchored to the installed `exceljs` dependency, so scripts can use already installed libraries
from the caller workspace. The pinned runtime includes the streaming `fast-csv`
parser through its existing `exceljs` dependency; no additional package or
format-specific MCP tool is installed. Scripts must respect logical records,
quoted delimiters, escaped quotes and embedded newlines, and report parse or
execution failures instead of inferring a result from physical line counts.
Programs compute and label the numeric quantities they report. Replies include
every requested metadata name within the output budget, rather than estimating
array lengths or offering the already requested list in a later message.

If a surface has no caller-bound workspace/download capability, an admitted source is reported as `workspace_delivery_unavailable`; MCP Host does not fall back to returning an oversized body.

## Approval and local processing

For an available GFS file reference above 8 KiB, the Host prepares the workspace
copy after the durable turn starts and before its first model request. It uses
the same caller-bound `clerum__gfs_download`, parameter validation, tool-lane
guardrails, doom-loop accounting, decision events, result transformation and
effective approval controller as the interactive tool flow. If policy denies the
operation or download approval is required, no copy is prepared
and the model receives a fixed unavailable code so the normal tool flow can
request that approval. Human-entered paths still require GFS discovery before
their pinned resource can be downloaded.

The model receives a validated receipt and decides how to process the local
file. Preparation does not parse the format, inject original bytes or image
parts, or grant shell execution. Its transfer uses the task's cancellation
signal and remaining execution duration.

Repeated preparation first reauthorizes the remote metadata, then looks for a
copy that this Host process published for the same caller, drive, resource,
version and size and that has not expired. It re-hashes that copy and checks
its private mode and the inode it published. A valid copy keeps its download
ID, path and expiry without another content transfer or quota reservation. Any
mismatch removes the copy and the file is downloaded again under a new ID;
reuse never matches a copy found on disk that this process did not publish (see
[Provenance](#provenance-and-what-survives-a-restart)). Preparation and
downloads pin receipts to a trusted task owner while its model, pending
approval or execution can still use them. Reuse adds an owner without replacing
another task's pin. A task releases its pin when its executor reaches a
terminal state. A replacement needs fresh GFS authorization.

Pins and provenance are held in memory. After a Host restart no copy is reused
and no pin exists: a resumed task that needs the file downloads it again under
a new ID, after fresh GFS authorization.

`shell_exec` remains the trust boundary:

- The working directory and `HOME` are the caller workspace. A supplied allowlisted or dynamic `HOME` cannot relocate execution outside it.
- `shell_exec` follows the same approval rules as every other native tool,
  such as `http_request` (as before #979): approving one call authorizes the
  rest of that turn, and "always" approval authorizes later turns. A guardrail
  rule with `action: 'ask'` on `shell_exec` restores per-call approval.
  Persisted approvals without a scope are treated as individual invocations.
- Combined retained command output is bounded to 1 MiB. Live progress is bounded to 64 KiB. Exceeding the output bound terminates the process group and returns a truthful `output_limit_exceeded` result.
- `shell_exec` never calls the GFS download store (#1019). It takes nothing
  from the store, does not depend on `store.isAvailable()`, and keeps
  running while the store is unavailable. When a Host-owned store exists,
  the shell stays bound to the verified caller root; before every command it
  re-verifies that the caller root is still canonical. That check is per-user
  directory scoping, not store state. Per-call live approval is forced only
  for `clerum__gfs_download`, and only for channel tasks on a Host with
  approval enabled, unless the approval configuration sets `shell_exec` to
  `false`. Cron, internal and approval-disabled tasks keep their existing
  approval policy.
- The store's lifecycle (expiry, pressure eviction, quota, `close()`) counts
  only its own transfers and task receipt owners. A running shell does not
  protect a copy and does not delay `close()`.

### Accepted risks

1. Expiry or eviction can remove a retained copy while a command is using it.
   A file descriptor that is already open keeps reading; a later open gets
   `ENOENT`.
2. A command can alter or delete a retained copy. Reuse and full managed reads
   re-hash the copy against the digest this process holds in memory and check
   that the file is still the inode it published. On a mismatch the copy is
   removed (`incomplete_removed`): reuse downloads the file again and a full
   managed read answers `download_missing`. The managed prefix read used for
   file-type detection checks the inode, size and mode but not the digest, so
   an alteration that keeps them is not detected by it; it only decides
   `not_image`, and any image goes on to the full hashed read before bytes are
   sent. Altered bytes therefore never reach a model, but an altered copy can
   stay on disk until its next reuse, full managed read, expiry or eviction. A
   deleted copy is a cache miss.
3. Executors share the Host UID and run without a sandbox or chroot. Live
   approval, `BasicSafety` validation and credential-slot stripping remain the
   shell's controls. The store has no lease or lock that a shell holds or
   waits on.
4. No admission or cleanup runs before a shell, so a command can read an
   expired copy until the next sweep removes it.
5. Caller isolation is a property of the managed store APIs, not of the shell.
   `createTransfer`, `publish`, `fail`, reuse, managed reads and pin release
   answer another caller's download exactly as they answer an ID that does not
   exist, with the same error code and message, so a caller cannot learn that
   another user's files exist through them. `shell_exec` runs with the Host
   UID and no chroot: an approved command can list and read other users'
   files under `users/*`, including their `.gfs-downloads` copies. Per-user
   isolation of the shell (a per-user UID, a chroot or a sandbox) is out of
   scope of #1028; approval remains the shell's control.
6. The retained-storage budget, free space and the Host-wide active-transfer
   limit are shared by every caller on a Host; there is no per-caller byte or
   file limit. A caller can therefore observe aggregate pressure from others
   (`host_quota_exceeded`, `disk_full`, Host-scope `download_busy`, or an eviction that
   removes one of its own unpinned copies), and one caller's admission can
   evict another caller's unpinned copies, which costs that caller a
   re-download. These signals carry no identity, count, name or path of
   another caller's files, and an evicted copy exposes no data.
7. Check-then-use windows on paths are narrowed, not closed. Node has no
   `openat`/`renameat`/`unlinkat`, so the store cannot hold a directory
   descriptor across a check and the call that uses the path. It opens files
   with `O_NOFOLLOW` and decides on the descriptor (`fstat` device and inode),
   publishes only the inode it hashed, re-checks the input directory created at
   admission before each rename, and removes a directory by first renaming it
   to a private `.trash-<uuid>` name inside its verified parent, checking the
   parent again and only then removing the private name (the rename is undone
   if the parent moved). The windows that remain can be won only by a process
   running with the Host UID, which can already alter or delete those files
   directly (risk 3); winning one gives no capability beyond that.
8. A turn-wide approval of `shell_exec`, like any turn-wide approval,
   auto-approves every approval-gated tool for the rest of the turn, not only
   shell commands: `http_request`, `cron_manage`, `file_write` and MCP tools run
   without a new approval card, including calls the model issues after it has
   read untrusted GFS content in that turn. This is the behaviour of an
   `http_request` approval, and of a `shell_exec` approval before #979. An
   "always" approval also keeps `shell_exec` approved in later turns. The shell
   runs with the Host UID. A configured `clerum__gfs_download` approval is still
   asked for each call. Operators who need per-call approval add a guardrail
   rule with `action: 'ask'` for `shell_exec` and for any other tool that must
   be asked each time.

Partial reads are not possible, because publication is an atomic `rename` of
`source.partial`.

Unix directory modes and random directory names do not provide cross-caller OS
isolation when a Host shares one UID: an approved shell command can create,
overwrite or delete any file under `users/`. The store therefore never takes
provenance from disk. Reuse and managed reads are served only for copies this
Host process published. Reuse and full managed reads re-hash the content against
the digest held in memory, and a mismatch deletes the copy; the managed prefix
read checks inode, size and mode only (see [Integrity](#integrity)).
Directories found on disk that this process did not publish (left by a previous
process or planted by a command) are counted against the Host budget and
removed when they expire or are evicted; they are never reused, never read back into a model and never pinned.
A Host restart therefore loses reuse for every copy, at the cost of one extra
download per file; accounting and cleanup survive the restart. Approved
arbitrary shell access remains a documented Stage 1 residual; stronger executor
isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before the tool result is returned, or reports `process_group_termination_failed` when its termination cannot be confirmed. A process that moved outside that group (for example through `setsid` or a detached spawn) can keep stdout/stderr open after the group is gone, so the Host bounds settlement without waiting for those pipes to close. After a timeout, cancellation or output overflow, termination has 5000 ms of SIGTERM grace and the call settles at the 6000 ms cleanup budget at the latest. When the command exits on its own, the Host checks every 1000 ms whether the process group is gone and settles once it is. If the group never disappears, the execution timeout still applies, followed by the same 6000 ms cleanup budget. In both cases the Host stops output capture, the result starts with `[stdio_held_by_detached_process: <reason>; ...]` and is an error, and a `shell_stdio_held_by_detached_process` warning is logged. This holds even when the command itself exits 0: the result is still an error (`is_error: true`), so the model may treat a successful command as failed and retry it, for example starting a second background daemon. The escaped process is not signalled and may keep running; this bounds the call, it does not contain the process. Redirect background output to a file or `/dev/null`. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

Generic workspace tools reject direct and symlink-resolved access to
`.gfs-downloads`, the pre-#1028 `.gfs-download-store` directory, every
`.gfs-download-store.retired-*` tree and every `.gfs-downloads.trash-*` tree
through `file_read`, `file_write`, memory
read/write, list/tree, and search. A name that only resembles them (for example
`.gfs-download-storex`) is an ordinary workspace path.
The protected absolute target is checked before relativizing it against a
workspace root, including when that root itself was replaced by an alias.

Caller binding canonicalizes the configured Host base, then verifies real
`users` and caller directories. The `users` parent is checked before creating a
caller child. Redirected caller namespaces produce unavailable bindings;
ordinary text tasks continue while managed tools remain denied. A legitimate
platform alias on the configured Host base is retained. Managed shell also
revalidates its actual canonical root before spawning.
These checks prevent a known redirected root from granting generic tool access
to the store. They do not provide FD-anchored executor isolation against all
shared-UID filesystem races; that remains the Stage 2 boundary.

## Retention, quotas, and recovery

The store keeps no ledger, lock, fence or database. Everything it needs to
account for and clean up copies is on disk in the directory of each download;
everything it needs to trust a copy (who downloaded it, its digest, its pins) is
held in the memory of the Host process that published it. No state on disk can
make a Host refuse downloads.

### On-disk layout

```
<hostRoot>/users/<key>/.gfs-downloads/                    0700
<hostRoot>/users/<key>/.gfs-downloads/input-<uuid>/       0700
    source.partial         0600  while the transfer is active
    meta.json.tmp-<uuid>   0600  during publication only
    meta.json              0600  the receipt (schema 1)
    source                 0600  the published copy
```

`<hostRoot>/users/<key>` is the verified caller workspace. `<key>` is the
channel-namespaced caller key (`_system` for tasks without a source message),
and it is also the store's caller identity: an admission whose identity is not
the key of its caller directory, or whose caller directory is not exactly
`<hostRoot>/users/<key>`, is refused. Two people with the same sender name on
different channels therefore never share reuse, managed reads or pins. The
receipt path
given to the model is `.gfs-downloads/input-<uuid>/source`, relative to that
workspace. `<uuid>` is random. Names in `.gfs-downloads` that do not match
`input-<uuid>` belong to the user and are never listed, charged or removed,
except `.trash-<uuid>` directories, which a removal interrupted between its
rename and its delete leaves behind and the next sweep removes.

### What counts as a complete download

A directory is complete when `meta.json` is a regular file (checked with
`lstat` before it is opened, so a socket, FIFO, device, directory or symlink
makes the directory incomplete) of at most the metadata size limit, opens
without following a symlink, and parses as a schema-1
receipt for the directory's own ID; its source fields, size, digest and dates
are well formed; the size is within the GFS admission limit; `expiresAt` is not
before `createdAt` and not later than `createdAt` plus the retention period; and
`createdAt` is at most 60 seconds ahead of the Host clock. `source` must be a
regular file (not a symlink) of exactly the recorded size. Anything else inside
an `input-<uuid>` directory that is not an active transfer of this process is
incomplete: it is not charged and the next sweep removes it.

### Provenance and what survives a restart

Each complete copy the store knows about is either _published_ (written by this
Host process) or _adopted_ (found on disk by a sweep). Only published copies are
reused, served by managed reads or pinned, and only for the caller that
downloaded them. Adopted copies count against the Host budget, are evicted
first and are removed when they expire.
A restart turns every copy into an adopted one: the files stay charged and are
cleaned up on schedule, and a model that needs one downloads it again.

### Publication order

1. The transfer streams into `source.partial`, opened with `O_NOFOLLOW`.
2. The store re-checks the caller directory and the input directory created at
   admission (same device and inode), hashes `source.partial` through its
   descriptor, compares the digest and size, sets mode `0600` and syncs it.
3. It writes `meta.json.tmp-<uuid>` (`O_EXCL`, `O_NOFOLLOW`, `0600`), syncs it
   and renames it to `meta.json`.
4. It renames `source.partial` to `source`, syncs the directory, and checks that
   `source` is the inode it hashed.
5. The copy enters the in-memory index as published and the receipt is
   returned.

A Host that stops after step 3 leaves `meta.json` without `source`; one that
stops earlier leaves no `meta.json`. Both are incomplete and are removed by the
next sweep. A failed publication returns `storage_write_failed` (or
`download_missing` when the partial file is no longer the one admitted) to that
call only; the caller removes the directory and the next admission is not
affected.

### Quotas and eviction

The store has one retained-storage limit: Host bytes. Usage is the sum of
complete copies, the reservations of active transfers and the duplicates a
sweep could not remove, in every caller's directory. The budget is
`floor(volume bytes × MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT / 100)`, where the
volume bytes are `blocks × bsize` from the same `statfs` of the Host root that
the free-space check reads at each admission, so a resized volume counts from
the next admission without a restart. By default the cache can therefore use
up to 85% of the volume. An admission is refused with `host_quota_exceeded`
(reason `storage_bytes`) when usage plus its size would exceed the budget; a
usage exactly at the budget is admitted. There is no per-caller file count and
no per-caller limit on unpinned copies: those per-user limits were removed by
user decision, and one caller can hold any number of unpinned copies while the
budget has room.

Eviction cannot reclaim what a caller protects: the unexpired copies its tasks
pin and its active reservations. A caller's protected bytes (each copy once,
whichever of its tasks pins it) may therefore reach at most `floor(budget / 2)`.
An admission that would take a caller over that half, or a reuse that would pin
a copy the caller does not protect yet, is refused with `host_quota_exceeded`
(scope `caller`, reason `protected_bytes`) before any eviction. The decision and
the error use only that caller's own usage; the error is the same as a full
Host budget. A single download larger than half the budget is always refused
(about 4.25 GiB on a 10 Gi volume at 85%, far above the per-file limit).
Re-pinning a copy the caller already protects adds nothing and is decided
before the volume is measured.

The cap bounds each caller, not their sum. Two callers at their caps together
protect `2 × floor(budget / 2)` bytes, that is the budget minus `budget mod 2`:
the whole budget when it is even, all but one byte when it is odd. Every
admission that does not fit in the rest is then refused (with an even budget,
every admission of a positive size) until a task releases its pins or the
pinned copies expire. This is an accepted risk: a pin never outlives the copy's
`expiresAt` (see [Retention pins](#retention-pins-and-cold-resume)), so each
pinned copy holds its share for at most the retention period,
`MCP_HOST_GFS_DOWNLOAD_TTL_HOURS` (168 hours by default). Callers whose tasks
keep pinning freshly downloaded copies, each with a new expiry, can keep the
budget saturated for longer than one retention period.

Before refusing, the store plans an eviction of complete copies that are
unpinned or pinned but already expired and are not being transferred, in any
caller's directory: adopted copies first (oldest `createdAt` first), then
published copies least recently used first (publication, reuse or managed
read). Unexpired pinned copies are never evicted. One
caller's admission can thus evict another caller's unpinned copies; that caller
pays a re-download on its next use and learns nothing about who caused it, and
the denial is the same code whoever's copies fill the budget. The whole plan is
computed before anything is deleted: when no plan fits, nothing is deleted and
the admission is refused. Eviction candidates are not hashed.

Shell writes do not trigger eviction. Files a command writes elsewhere in a
workspace share the volume with the cache but are not charged to the budget, so
a full disk can make a shell write fail with `ENOSPC` until the next download
admission evicts unpinned copies to free space or the next sweep removes
expired ones. Nothing evicts copies between admissions.

Free space must cover the block-rounded size of the new download, every
active reservation and a 16 MiB margin. The admission sweep runs first, so
expired copies (pinned ones included) and incomplete directories are removed
before the volume is measured and never cause a `disk_full`. One eviction plan
then covers both deficits: the bytes over the budget and the free-space
deficit (`required − available bytes`, each candidate credited with its
block-rounded size), with the same candidates and order as above. Files that
are not cache copies (other workspace files, other services on the volume)
therefore make the store evict unpinned copies instead of refusing. The checks
run in this order, all before anything is deleted: if the evictable copies
cannot cover the free-space deficit, the admission is refused with `disk_full`
(reason `free_space`); then the per-caller protected cap; then, if no plan fits
the budget, `host_quota_exceeded`. After the eviction the budget and the free
space are checked again, and a volume still short is refused with
`disk_full`. A volume that cannot hold the download therefore costs no cached
copy. A `statfs` that reports a block size or block count that is not
positive, or a negative available-block count, cannot size a budget. The store
then measures the volume once more; if the second reading is valid the
admission proceeds with it, and if it is still invalid the admission is
refused with `volume_unmeasurable` (reason `free_space`), not `disk_full`,
because an unmeasurable volume is not evidence that the disk is full. This
applies to every measurement of the volume. A Host runs at most 2
transfers at once, and a caller at most its configured concurrency; beyond that
admission returns `download_busy`.

If `MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT` is lowered or the volume shrinks,
existing copies remain charged and new admissions evict or are refused until
usage falls below the new budget.
Lowering `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS` or `MCP_HOST_GFS_MAX_FILE_BYTES` is
different: a `meta.json` is validated against the limits in force, so after the
restart every copy whose size or retention exceeds the new value is incomplete
and the first sweep removes it (counted as `incomplete_removed`). No reuse is
lost by this, because a restart already makes every copy adopted.

### Expiry and sweeps

A sweep runs when the store initializes, before every admission, and hourly
after that. It walks `users/*/.gfs-downloads/input-*` without following
symlinks. It removes incomplete directories and expired copies, pinned ones
included. It never touches a directory that is an active transfer of this process,
and it never replaces a published copy: another directory carrying the same ID
is removed. A `.gfs-downloads` that is a symlink or not a directory is removed
by the sweep without following it and recreated on the next admission.

An admission replaces a caller's `.gfs-downloads`, deleting every copy in it
(pinned ones included), only when the check answers about the directory itself:
it is a symlink or not a directory, it is gone (`ENOENT`), the check fails with
`ELOOP`, `ENOTDIR` or `EACCES`, or its owner or mode (for example after a
`chmod 755` from a shell) is not the store's private one. Any
other error (`EMFILE`, `EIO`, ...) proves nothing about the directory: the
admission fails with `storage_write_failed` and the directory and its copies
stay. The same distinction applies to every check of a copy: reuse, managed
reads and the sweep remove a copy only on a size, inode or digest mismatch, an
untrusted owner, mode or type, or one of those errnos. On any other error the
copy is kept and checked again later; reuse logs `GFS download store could not
verify a published copy for reuse; it is kept and checked again later`, a
managed read answers `download_missing` and logs `GFS download store could not
read a published copy for its caller`, and the sweep logs `GFS download store
could not inspect a download directory; it is kept and the next sweep retries
it` and counts `sweep_failed`. All three log the error code only.

A directory that cannot be listed is skipped and retried by the next sweep
(`sweep_failed`). A removal that fails is logged with its error code
(`remove_failed`) and retried by the next sweep. When the removal of a renamed
copy fails with `EACCES` or `EPERM` (for example after a command ran
`chmod 0500` on it), the store adds owner `rwx` to every real directory in
that tree (symlinks are not followed) and retries once; a directory made
read-only from a shell therefore does not hold its charge forever. The change
is path-based, so a name swapped for a symlink between the `lstat` and the
`chmod` can gain owner bits on another inode the Host UID owns, which a
command running as that UID can already change. A `.gfs-downloads` parent
made unwritable is not repaired: its copies stay in place and charged. A
removal that fails before
its rename leaves the copy where it is, indexed and charged, and a published
copy stays published. A removal that renamed the copy and then failed leaves it
under its trash name (below): it stays charged there until its removal succeeds
or its absence is confirmed. A duplicate
directory whose removal failed stays charged against the Host budget until a
removal succeeds or `lstat` proves it gone: `ENOENT`, `ENOTDIR` (a parent such
as the caller root is no longer a directory) or a path that is no longer a
directory. Any other `lstat` error keeps the charge. When a later sweep cannot
inspect it (an error other than a size, type or content mismatch) or cannot
list its `.gfs-downloads`, the charge of the previous sweep carries over;
a directory that is now indexed or being transferred is charged once, through
its entry or reservation. Only a
removal that moved a directory counts as `incomplete_removed` or
`expired_removed`; one whose directory never existed counts nothing. Expiry is the boundary itself: a
copy whose `expiresAt` equals the current time is expired for reuse, managed
reads and the sweep.

Every removal renames the directory to a private name inside its verified
parent, checks the parent again and removes only the private name; the removal
is proven by `ENOENT` afterwards. The private name is one the sweep lists in
that parent: `.trash-<uuid>` inside `.gfs-downloads`,
`.gfs-downloads.trash-<uuid>` in a caller root (a replaced `.gfs-downloads`)
and `.gfs-download-store.retired-<uuid>` in the Host root. A removal that stops
between its rename and its `rm` leaves that name behind; the next sweep removes
it, and workspace tools treat it as protected until then. The charge follows the
renamed directory: its bytes stay charged against the Host budget until a
removal succeeds or its absence is confirmed, so a trash directory whose
removal keeps failing stays charged until it is removed. An indexed entry left
under a trash name is dropped from the index, because its name is gone, and is
charged only on the trash name, never twice. An unindexed expired copy whose
removal fails after the rename is charged on its trash name with the size read
from its `meta.json`. A failed transfer keeps its reservation as the charge of
whatever its removal leaves on disk, under its own name or a trash name. A
directory the store holds no charge for when it removes it (an unindexed
incomplete directory, or a trash directory left before this process started,
since charges are held in memory) is measured on its trash name (the bytes of
its regular files, symlinks not followed; each directory is checked again
when its turn comes, so one that is not a real directory then, such as a
symlinked `.gfs-downloads` or a child replaced by a symlink during the walk,
measures zero) and charged that size if its removal fails. A tree that cannot
be measured is logged and stays uncharged until a later sweep measures it.
A charge, once set, is not measured again: bytes written into a directory
after its charge was set, while its removal keeps failing, are not added to
the budget, although the free-space check still sees them.
When a removal leaves the directory under its own name (the rename failed, the
parent check refused before it, or a refusal after it was undone by renaming
it back), an indexed entry keeps its own charge and is never charged a second
time, and a charge in hand stays on the directory. A directory with no charge
is measured the same way and charged under its own name if its parent passes
the check again; one whose parent is still refused is not read and stays
uncharged until a later removal finds the parent safe. When the parent check
refuses after the rename and the rename back also
fails, the refusal is reported (a replaced `.gfs-downloads` refuses the
admission with `workspace_unavailable`), the undo failure is logged as `GFS
download store could not restore a directory after refusing to remove it` with
its error code, and a charge in hand moves to the trash name; a trash directory
in a refused parent is not read to measure it. Measuring walks the tree inside
the store's lock, so a large tree planted under a store name delays other
admissions and sweeps for the walk (about 12 µs per entry); it never fails
them.

### Retention pins and cold resume

A task that prepares or downloads a copy pins it while its model, pending
approval or execution can still use it. A pin protects the copy from eviction
until its `expiresAt`, never beyond, and is released when the task reaches a
terminal state. Expiry is absolute: once a pinned copy expires, it no longer
counts toward its caller's protected bytes, eviction may reclaim it, and the
next sweep removes it even though the task still holds its pin. A task that
still needs the file downloads it again. A prepared copy past its expiry is
not marked in the turn context: while it is still on disk, a command that reads
its path uses it; after the sweep removes it, the command fails (`ENOENT`) and
the model downloads the file again. A resume after approval replays the
first-turn context unchanged. Pins are per caller: another caller
using the same owner ID holds a different pin. Pins are held in memory, so after
a restart a resumed task finds its copy unpinned and not reusable, and downloads
it again. A shell command never pins a copy. A pin is not bounded by the task's
active-time budget (a task waiting for approval keeps its pins), which is why a
caller's pinned and reserved bytes are capped at half the budget (see Quotas and
eviction).

### Integrity

Reuse re-hashes the whole copy through a descriptor whose inode must be the one
published, and checks its size and `0600` mode. A managed read reads exactly the
recorded size from that descriptor, refuses a longer file and compares the
digest with the one in memory, never with `meta.json`. A mismatch removes the
copy (`incomplete_removed`) and answers `download_missing`. A managed prefix
read (file-type detection) checks the inode, size and mode but does not hash,
so it does not detect an alteration that keeps them. Its bytes only decide
`not_image`; an image is always read in full, and digest-checked, before any
byte is sent to a model.

### Errors visible to the model

| Code                    | Meaning                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host_quota_exceeded`   | The Host's retained bytes would exceed the volume budget and eviction cannot make room, or the caller's protected bytes would exceed its cap of half the budget. |
| `disk_full`             | Free space on the Host volume cannot hold the download, every active reservation and the 16 MiB margin.                                                          |
| `volume_unmeasurable`   | The Host volume's `statfs` was invalid on two consecutive readings, so no budget or free space could be computed.                                                |
| `limit_exceeded`        | The declared size is not a non-negative integer up to `MCP_HOST_GFS_MAX_FILE_BYTES`.                                                                             |
| `download_busy`         | Too many active transfers, the store is closed or closing, or no such transfer exists.                                                                           |
| `download_missing`      | No copy this process published for this caller has that path, or the copy failed verification.                                                                   |
| `download_expired`      | The copy or the transfer is past its expiry.                                                                                                                     |
| `publication_cancelled` | The task was cancelled or ran out of time while the copy was being verified or published.                                                                        |
| `storage_write_failed`  | A filesystem operation failed during admission, publication or removal.                                                                                          |
| `workspace_unavailable` | The store is not initialized, or the Host root or caller directory is not a real directory inside the Host root.                                                 |
| `caller_mismatch`       | The request carries no caller identity, one that is not its caller directory's key, or a malformed retention owner ID.                                           |

Another caller's download is answered with the same code and message as an ID
that does not exist (`download_missing` for reads and publication,
`download_busy` for a transfer being abandoned).

### Space refusals and the guidance the model receives

The two space refusals carry a fixed guidance text so the model can tell the
user what happened and what they can do:

- `disk_full`: the Host workspace disk is full. The model tells the user and
  offers to list the files in the user's own workspace (the shell working
  directory, e.g. `du -sh -- * .[!.]* 2>/dev/null | sort -h`) and to delete
  what the user no longer needs with a `shell_exec` command the user approves.
  It never lists, reads or deletes another user's directory or anything
  outside the workspace.
- `host_quota_exceeded`: the Host's cache of downloaded files is full. Space
  frees as tasks finish and downloaded copies expire. The model tells the user,
  who can finish or cancel their own running tasks to free space sooner and
  then try again. It never acts on another user's tasks or files. The text
  offers no deletion of downloaded copies, because that cannot admit the
  download: the budget refusal comes when evicting every copy no running task
  protects would still not make room (the store then evicts nothing), or when a
  planned eviction fails to remove a copy (the copies already removed stay
  removed, and the one left on disk stays charged until a sweep removes it).
  The per-caller cap is checked before any eviction and counts only the copies
  the caller's running tasks protect.

`volume_unmeasurable` carries no guidance: the volume could not be measured,
and no cleanup by the user would change that. `limit_exceeded` and every other
store code carry no guidance either.

Neither text names, counts or hints at whose files use the space, and neither
interpolates any value. The texts live in
`mcp-host/src/internalTools/gfsSpaceGuidance.ts` and reach the model on two
paths:

- A direct `clerum__gfs_download` (or managed `clerum__gfs_read`) call returns
  the fixed envelope `GFS download store failed (<code>)` as the first line of
  the tool error and the guidance as the second line.
- A large file reference prepared before the turn is rendered as
  `prepared_gfs_file: ... status=unavailable code=disk_full` (or
  `code=quota_exceeded`), followed once per code by a
  `For code=<code>: <guidance>` line in the turn context. Preparation accepts
  the envelope alone or the envelope followed by exactly its own guidance line;
  any other second line maps to `download_failed`. The bare
  `volume_unmeasurable` envelope is rendered as `code=volume_unmeasurable`
  with no `For code=` line; with any second line it maps to `download_failed`.

The `free_space` metric counts `disk_full` refusals and the `volume_unmeasurable`
refusals described in [Quotas and eviction](#quotas-and-eviction).

### Initialization and availability

`initialize()` fails only when the Host root is not a usable directory
(`workspace_unavailable`). The runtime then logs `GFS download store
unavailable; managed GFS operations are disabled and initialization is retried
by the hourly cycle`, keeps safe RPC capabilities running, and retries hourly.
Managed shell execution keeps the verified caller root and continues; it cannot
fall back to the Host's shared workspace. A failed sweep never makes the store
unavailable.

`close()` stops admission and, within one 5-second deadline, waits for an
`initialize()` still in progress (which then fails with `download_busy`), for
active transfers, and then for the mutation queue to stay unchanged, so a
sweep accepted while `close()` was waiting also finishes. Every call returns
the same promise. A managed read that finishes after `close()` does not remove
its copy. Directories of transfers still active at the deadline are removed by
the next start.

Execution safety binding is independent of delivery eligibility and of store
availability. Cron, internal and approval-disabled tasks associated with this
store cannot obtain a shared-root shell. Trusted system tasks use the existing
system workspace contract; a missing verified root denies spawning. Healthy
unattended execution keeps its existing policy, while large workspace delivery
still requires its attended caller and approval capability.

Kubernetes permits multiple Pods on one node to use a ReadWriteOnce volume, so
two Hosts can overlap during a rolling update. The store takes no lock across
processes. During the overlap each Host enforces the quota on its own
reservations, so their combined usage can exceed it, and the starting Host's sweep can remove a transfer the terminating
Host is still draining; that transfer fails with `storage_write_failed` in a
task that is being interrupted anyway.

The first rollout from the dev image (`74e0d81d9`) to this one extends that
risk. The starting Host's first sweep retires the dev Host's live
`.gfs-download-store` (its ledger and writer fence), so the dev Host's ledger
writes fail with `ENOENT`, and it removes the dev Host's completed `input-*`
directories, which have no `meta.json`. For the rest of the overlap the
terminating dev Host's managed reads of finished downloads fail as well, not
only its transfers. The window is the termination grace period; the affected
files are downloaded again by the new Host on their next use.

## Metrics

The global `/metrics` endpoint exposes fixed-cardinality instruments:

- `clerum_gfs_download_admissions_total{outcome}`
- `clerum_gfs_download_transfers_total{outcome}`
- `clerum_gfs_download_duration_seconds`
- `clerum_gfs_download_active`
- `clerum_gfs_download_quota_total{scope,reason}`, with `reason` one of
  `storage_bytes`, `active_downloads`, `free_space`, `protected_bytes`
  (`storage_bytes` and `free_space` are Host-scope only, `protected_bytes`
  caller-scope only)
- `clerum_gfs_download_expiry_total{outcome}`, with `outcome` one of
  `expired_removed` (expired or evicted), `incomplete_removed`, `remove_failed`,
  `retired_legacy_store`, `sweep_failed`
- `clerum_gfs_shell_output_limits_total{outcome}`

Labels contain bounded enums only. Caller, resource, download, command, path, correlation IDs, filenames, credentials, and raw output are prohibited as metric labels and log fields.

Logs from the store use the component `GfsDownloadStore`:

- `info` `GFS download store initialized` with `removedIncomplete`,
  `removedExpired`, `retainedCompleted`, `retainedBytes`, `adopted` and
  `retiredLegacyStore`.
- `warn` `GFS download store could not remove a download directory; the next
sweep retries it` and `GFS download store could not list a download
directory; the next sweep retries it`, each with an errno `code`.
- `warn` `GFS download store closed with active transfers; their directories
are removed at the next start` with the `active` count.
- `warn` `GFS download store ignores a removed retained-storage variable; the
budget is MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT of the workspace volume`, once
  per removed variable that is set, with the `variable` name only. It is
  emitted once per store instance (once per Host process), not on every
  `initialize()` retry.

## Rollout and rollback

1. Apply the ConfigMap environment values through the supported HCC rollout. Updating a ConfigMap alone does not update an existing Pod.
2. Verify the new values and `/metrics` endpoints from newly created Hosts.

No manual action is needed on a volume written by an earlier image. Every sweep,
including the first one at startup, retires the ledger store of the pre-#1028
image:

1. `<hostRoot>/.gfs-download-store` (its ledger, writer fence, SQLite database
   and lease files) is renamed to `.gfs-download-store.retired-<uuid>` inside
   the Host root. Nothing inside it is read. The Host logs `warn` `Retired the
pre-#1028 GFS download store` with the number of files and bytes it held,
   and `clerum_gfs_download_expiry_total{outcome="retired_legacy_store"}`
   increments.
2. Every `.gfs-download-store.retired-*` tree is removed the way any store
   directory is.
3. The sweep removes every `input-<uuid>` directory the old store left, because
   none has a schema-1 `meta.json`; completed, transferring and quarantined
   records of the old store all go this way. The startup `info` line reports
   them as `removedIncomplete`, with `retiredLegacyStore: true`.

A step that fails is logged as `warn` `GFS download store could not retire the
pre-#1028 store; the next sweep retries it` with an errno `code` and the `step`
(`inspect`, `rename`, `list` or `remove`), and counts as `remove_failed`. The
store stays available; the leftover costs disk space until a later sweep
removes it. A retired tree is protected from workspace tools until then.

Rolling back to the dev image (`74e0d81d9`) is safe. That image creates a new
`.gfs-download-store` with an empty ledger and a fresh writer fence, and ignores
the `meta.json` directories this image left. The dev image charges only its
ledger records, so those directories are outside its accounting: they are not
charged against its quota, only its free-space check sees them, and their size
is bounded by the budget in force when this image wrote them (85% of the volume
by default) plus any partial files. They stay until a later image sweeps them. A
retired tree or a `.gfs-downloads.trash-*` tree left by a failed removal is not
protected from workspace tools under that image. Rolling forward again retires
the store the dev image created and keeps every copy that is still complete and
unexpired, as adopted. This was checked once outside CI by starting the dev
store on volumes this image had migrated, with and without a retired leftover,
and admitting a download on each.
