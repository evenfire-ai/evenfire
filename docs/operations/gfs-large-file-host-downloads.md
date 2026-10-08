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

| Environment variable                         |      Default |             Ceiling | Meaning                                                           |
| -------------------------------------------- | -----------: | ------------------: | ----------------------------------------------------------------- |
| `MCP_HOST_GFS_MAX_FILE_BYTES`                |   `16777216` |         `209715200` | Largest GFS source admitted by MCP Host.                          |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`        | `1073741824` | deployment-approved | Aggregate retained download budget.                               |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES` |  `268435456` |    aggregate budget | Per-caller retained download budget.                              |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES`     |          `8` |                `64` | Retained files per caller, complete copies plus active transfers. |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY`   |          `1` |                 `2` | Simultaneous active transfers per caller.                         |
| `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS`            |        `168` |              `8760` | Retention period for a completed copy.                            |

All values are parsed as positive decimal byte/count/hour integers. Empty, fractional, negative, exponent, padded, partial, non-integer, and above-ceiling values fail startup. Per-caller storage cannot exceed aggregate storage.

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
- Each command on this managed workspace surface requires fresh live user
  approval. Consent authorizes the exact frozen invocation. It does not grant
  `*`, another tool, an entire MCP server, a future shell call or unattended
  execution. Deliberately turn-wide approvals on other surfaces retain their
  proven scope. Persisted approvals without a scope are treated as individual
  invocations.
- Combined retained command output is bounded to 1 MiB. Live progress is bounded to 64 KiB. Exceeding the output bound terminates the process group and returns a truthful `output_limit_exceeded` result.
- `shell_exec` never calls the GFS download store (#1019). It takes nothing
  from the store, does not depend on `store.isAvailable()`, and keeps
  running while the store is unavailable. When a Host-owned store exists,
  the shell stays bound to the verified caller root; before every command it
  re-verifies that the caller root is still canonical. That check is per-user
  directory scoping, not store state. Live approval of `shell_exec` and
  `clerum__gfs_download` is forced only for channel tasks on a Host with
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
6. Quotas, free space and the Host-wide active-transfer limit are shared by
   every caller on a Host. A caller can therefore observe aggregate pressure
   from others (`host_quota_exceeded`, Host-scope `download_busy`, or a Host
   eviction that removes one of its own unpinned copies). These signals carry
   no identity, count, name or path of another caller's files.
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
process or planted by a command) are counted against the quota of the
`users/<key>` directory that contains them and removed when they expire or are
evicted; they are never reused, never read back into a model and never pinned.
A Host restart therefore loses reuse for every copy, at the cost of one extra
download per file; accounting and cleanup survive the restart. Approved
arbitrary shell access remains a documented Stage 1 residual; stronger executor
isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before the tool result is returned, or reports `process_group_termination_failed` when its termination cannot be confirmed. A process that moved outside that group (for example through `setsid` or a detached spawn) can keep stdout/stderr open after the group is gone, so the Host bounds settlement without waiting for those pipes to close. After a timeout, cancellation or output overflow, termination has 5000 ms of SIGTERM grace and the call settles at the 6000 ms cleanup budget at the latest. When the command exits on its own, the Host checks every 1000 ms whether the process group is gone and settles once it is. If the group never disappears, the execution timeout still applies, followed by the same 6000 ms cleanup budget. In both cases the Host stops output capture, the result starts with `[stdio_held_by_detached_process: <reason>; ...]` and is an error, and a `shell_stdio_held_by_detached_process` warning is logged. The escaped process is not signalled and may keep running; this bounds the call, it does not contain the process. Redirect background output to a file or `/dev/null`. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

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

A directory is complete when `meta.json` is a regular file of at most the
metadata size limit, opens without following a symlink, and parses as a schema-1
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
downloaded them. Adopted copies count against the quota of the `users/<key>`
directory that holds them, are evicted first and are removed when they expire.
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

Usage is the sum of complete copies plus the reservations of active transfers.
A caller's usage is everything under its own `users/<key>` directory, whoever
wrote it. Admission refuses with `caller_quota_exceeded` when the caller's bytes
or files would exceed its limits, and with `host_quota_exceeded` when the Host
totals would (1024 MiB and 64 files by default). Before refusing, the store
plans an eviction of complete, unpinned copies that are not being transferred:
adopted copies first (oldest `createdAt` first), then published copies least
recently used first (publication, reuse or managed read). A caller-quota denial
evicts only that caller's own copies; a Host-quota denial can evict any
caller's. The whole plan is computed before anything is deleted: when no plan
fits, nothing is deleted and the admission is refused. Eviction candidates are
not hashed.

Free space is checked before the plan and again after it. Free space must cover
the block-rounded size of the new download, every active reservation and a
16 MiB margin; otherwise the admission is refused with `host_quota_exceeded`
(reason `free_space`). The first check runs before any eviction, so a volume
that cannot hold the download costs no cached copy. A Host runs at most 2
transfers at once, and a caller at most its configured concurrency; beyond that
admission returns `download_busy`.

If the quota limits (`MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`, the caller limits
or the file counts) are lowered, existing copies remain charged and new
admissions evict or are refused until usage falls below the new policy.
Lowering `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS` or `MCP_HOST_GFS_MAX_FILE_BYTES` is
different: a `meta.json` is validated against the limits in force, so after the
restart every copy whose size or retention exceeds the new value is incomplete
and the first sweep removes it (counted as `incomplete_removed`). No reuse is
lost by this, because a restart already makes every copy adopted.

### Expiry and sweeps

A sweep runs when the store initializes, before every admission, and hourly
after that. It walks `users/*/.gfs-downloads/input-*` without following
symlinks. It removes incomplete directories and expired copies that no task
pins. It never touches a directory that is an active transfer of this process,
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
(`remove_failed`) and retried by the next sweep; the copy stays where it is,
indexed and charged to its caller, and a published copy stays published. Only a
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
it, and workspace tools treat it as protected until then. When the parent
check refuses and the rename back also fails, the refusal is reported and the
undo failure is logged as `GFS download store could not restore a directory
after refusing to remove it` with its error code.

### Retention pins and cold resume

A task that prepares or downloads a copy pins it while its model, pending
approval or execution can still use it. A pin protects the copy from expiry and
eviction and is released when the task reaches a terminal state. Pins are per
caller: another caller using the same owner ID holds a different pin. Pins are
held in memory, so after a restart a resumed task finds its copy unpinned and
not reusable, and downloads it again. A shell command never pins a copy.

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

| Code                    | Meaning                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `caller_quota_exceeded` | The caller's retained bytes or files would exceed its limits and eviction cannot make room.                            |
| `host_quota_exceeded`   | The Host's bytes or files, the admission size limit or free space would be exceeded.                                   |
| `download_busy`         | Too many active transfers, the store is closed or closing, or no such transfer exists.                                 |
| `download_missing`      | No copy this process published for this caller has that path, or the copy failed verification.                         |
| `download_expired`      | The copy or the transfer is past its expiry.                                                                           |
| `publication_cancelled` | The task was cancelled or ran out of time while the copy was being verified or published.                              |
| `storage_write_failed`  | A filesystem operation failed during admission, publication or removal.                                                |
| `workspace_unavailable` | The store is not initialized, or the Host root or caller directory is not a real directory inside the Host root.       |
| `caller_mismatch`       | The request carries no caller identity, one that is not its caller directory's key, or a malformed retention owner ID. |

Another caller's download is answered with the same code and message as an ID
that does not exist (`download_missing` for reads and publication,
`download_busy` for a transfer being abandoned).

### Initialization and availability

`initialize()` fails only when the Host root is not a usable directory
(`workspace_unavailable`). The runtime then logs `GFS download store
unavailable; managed GFS operations are disabled and initialization is retried
by the hourly cycle`, keeps safe RPC capabilities running, and retries hourly.
Managed shell execution keeps the verified caller root and continues; it cannot
fall back to the Host's shared workspace. A failed sweep never makes the store
unavailable.

`close()` stops admission, waits up to 5 seconds for active transfers and then
closes; directories of transfers still active are removed by the next start.

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
  `storage_bytes`, `retained_files`, `active_downloads`, `free_space`
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
is bounded by the quota in force when this image wrote them (1024 MiB by
default) plus any partial files. They stay until a later image sweeps them. A
retired tree or a `.gfs-downloads.trash-*` tree left by a failed removal is not
protected from workspace tools under that image. Rolling forward again retires
the store the dev image created and keeps every copy that is still complete and
unexpired, as adopted. This was checked once outside CI by starting the dev
store on volumes this image had migrated, with and without a retired leftover,
and admitting a download on each.
