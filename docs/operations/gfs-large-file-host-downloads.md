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

| Environment variable                         |      Default |             Ceiling | Meaning                                   |
| -------------------------------------------- | -----------: | ------------------: | ----------------------------------------- |
| `MCP_HOST_GFS_MAX_FILE_BYTES`                |   `16777216` |         `209715200` | Largest GFS source admitted by MCP Host.  |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`        | `1073741824` | deployment-approved | Aggregate retained download budget.       |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES` |  `268435456` |    aggregate budget | Per-caller retained download budget.      |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES`     |          `8` |                `64` | Retained files per caller, in any state.  |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY`   |          `1` |                 `2` | Simultaneous active transfers per caller. |
| `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS`            |        `168` |              `8760` | Retention period for a completed copy.    |

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

Repeated preparation first reauthorizes the remote metadata, then verifies the
retained caller, resource version, size, expiry, private file and checksum. A
valid copy keeps its download ID, path and expiry without another content
transfer or quota reservation. Preparation and downloads pin receipts to a
trusted task owner while its model, pending approval or execution can still use
them. Reuse adds an owner without replacing another task's pin. A task releases
its pin when its executor reaches a terminal state. A positively absent copy may
release its charge; corrupt or ambiguous copies remain charged (see
[Retention, quotas, and recovery](#retention-quotas-and-recovery)).
A replacement needs fresh GFS authorization.

After a clean v2 writer restart, pins alone do not disable delivery. Fresh remote authorization and source version, size,
checksum and caller validation can rebind the exact restored task owner to the
new writer session. Other tasks keep their pins. A task ID alone is insufficient
to recover access.

`shell_exec` remains the trust boundary:

- The working directory and `HOME` are the caller workspace. A supplied allowlisted or dynamic `HOME` cannot relocate execution outside it.
- Each command on this managed workspace surface requires fresh live user
  approval. Consent authorizes the exact frozen invocation. It does not grant
  `*`, another tool, an entire MCP server, a future shell call or unattended
  execution. Deliberately turn-wide approvals on other surfaces retain their
  proven scope. Persisted approvals without a scope are treated as individual
  invocations.
- Combined retained command output is bounded to 1 MiB. Live progress is bounded to 64 KiB. Exceeding the output bound terminates the process group and returns a truthful `output_limit_exceeded` result.
- `shell_exec` never calls the GFS download store (#1019). It does not acquire
  a processing lease, does not depend on `store.isAvailable()`, and keeps
  running while the store is recovery-required. When a Host-owned store exists,
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

Accepted risks of this decoupling:

1. Expiry or eviction can remove a retained copy while a command is using it.
   A file descriptor that is already open keeps reading; a later open gets
   `ENOENT`.
2. A command can alter a retained copy. Two checks prevent its reuse, and they
   handle it differently:
   - `reusableReceipt` checks the file type, size, `0600` mode and SHA-256
     before reuse. On any mismatch, or when the copy cannot be opened, it sets
     the record to `missing`, deletes its stored checksum and persists the
     ledger. It writes no log and no metric. The record stays charged; the
     hourly expiry sweep removes it after its TTL if the Host is still running.
   - Startup reconciliation re-hashes every `completed` copy and sets an
     altered one to `quarantined`, keeping its checksum. It also sets every
     record that is not `completed`, including a `missing` one, to
     `quarantined`. A quarantined record is never expired or evicted.
3. The processing lease was never a security boundary: executors share the Host
   UID and run without a sandbox. Live approval, `BasicSafety` validation and
   credential-slot stripping remain the shell's controls.
4. Admission cleanup no longer runs before a shell, so a command can read an
   expired copy until the hourly sweep removes it.

Partial reads are not possible, because publication is an atomic `rename` of
`source.partial`.

Unix directory modes and random directory names do not provide cross-caller OS isolation when a Host shares one UID. Approved arbitrary shell access remains a documented Stage 1 residual; stronger executor isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before the tool result is returned. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

Generic workspace tools reject direct and symlink-resolved access to
`.gfs-downloads` and the complete `.gfs-download-store` accounting namespace
through `file_read`, `file_write`, memory read/write, list/tree, and search.
The protected absolute target is checked before relativizing it against a
workspace root, including when that root itself was replaced by an alias.

Caller binding canonicalizes the configured Host base, then verifies real
`users` and caller directories. The `users` parent is checked before creating a
caller child. Redirected caller namespaces produce unavailable bindings;
ordinary text tasks continue while managed tools remain denied. A legitimate
platform alias on the configured Host base is retained. Managed shell also
revalidates its actual canonical root before spawning.
These checks prevent a known redirected root from granting generic tool access
to accounting. They do not provide FD-anchored executor isolation against all
shared-UID filesystem races; that remains the Stage 2 boundary.

## Retention, quotas, and recovery

- Completed copies have a configured maximum retention time, seven days by
  default. Task receipt pins protect a copy past its TTL until the task
  releases them. A shell execution does not protect a copy (accepted risk 1).
- Host and caller quotas account for partial and completed files. Unknown or corrupt accounting fails closed rather than reporting zero usage.
- A new store publishes an atomic schema-1 ledger before accepting transfers. Every existing ledger is parsed, including empty content; invalid record or owner maps, and malformed legacy processing-lease maps, are rejected with `corrupt_store_ledger`.
- A pre-existing store directory with a missing ledger is unknown accounting, including an interrupted first initialization before ledger publication. Startup rejects it and preserves retained bytes for operator recovery instead of silently resetting quota. This can require recovery after a bootstrap interruption.
- Startup does not reconstruct an accounting directory deleted in its entirety while caller copies remain. Approved shell commands share the Host UID and can destroy this state; whole-store deletion remains outside the recovery guarantee and requires operator inventory of retained copies.
- Admission may evict the oldest copies whose record is `completed`, that have
  no active transfer and no task receipt owner, and whose content re-verifies.
  The complete eviction plan must satisfy both Host and caller quotas before any
  copy is removed. A caller-quota denial can only evict that caller's own
  copies. Records in any other state (`transferring`, `missing`,
  `cleanup_failed`, `quarantined`), pinned or active copies, and copies that
  fail verification are never pressure victims. Quota limits still reject a
  request when no safe complete plan exists.
- Before pressure effects, current verified filesystem capacity must cover the
  incoming block-rounded reservation, the 16 MiB safety margin and pending
  active reservations. Apparent file length and allocated blocks do not prove
  how much a reflink or snapshot deletion will release. This generic policy does
  not credit hypothetical physical reclamation; insufficient current capacity
  rejects without deleting pressure victims. Quota eviction can still proceed
  when current physical capacity is sufficient. Capacity is checked again after
  settlement and before admission because external filesystem changes can race.
- Only positively identified expired or pressure-evictable entries are deleted.
  Quota charges are released only after positive filesystem absence. A cleanup
  failure remains charged and is observable for recovery.
- Startup reconciles the ledger and partial files before the capability is advertised.
- Legacy processing leases written by builds before #1019 are discarded at
  initialize, after the ledger is parsed and before reconciliation. No lease in
  an older ledger can protect an executor of the current boot, and a lease left
  by a crashed Host would otherwise fence the store forever. The removal is
  persisted first. When that persist succeeds, the Host logs a warning with the
  count and increments `clerum_gfs_legacy_processing_leases_discarded_total`.
  When it fails, initialize rejects and the Host logs a `warn` with outcome
  `unknown` and the lease count; the counter is not incremented. The outcome is
  unknown because the persist can fail after the rename, while syncing the
  store directory: the lease-free ledger may already be the one on disk. In
  that case the next initialize finds no leases and reports no discard, so the
  `unknown` warning is the only record of it. The counter therefore counts only
  confirmed discards. Records that protected copies are then reconciled like
  any other: an intact completed copy is reusable, an altered or unfinished one
  is quarantined.
- At the end of initialize, after reconciliation and the final persist, the
  Host counts every `quarantined` record in the ledger, including those this
  boot quarantined, and sets the gauge
  `clerum_gfs_download_store_quarantined_records` to that count. The gauge
  holds the current count and does not accumulate across boots. When the count
  is above zero the Host logs the warning
  `GFS download store holds <n> quarantined record(s) charged to quota`. Quarantined records stay charged to
  quota and are never expired, evicted or reused. Operator recovery can return
  one to `completed` only when its published copy still matches its stored size
  and checksum; it cannot reclassify or remove a quarantined record whose
  content no longer matches its checksum (recovery step 5).
- Shutdown stops new admission, drains active transfers where possible, and leaves unproven recovery state protected.
- Pending and queued admission rechecks shutdown after asynchronous validation and persistence. Shutdown rechecks active ownership before releasing the writer lease.

Writer exclusion uses the existing SQLite dependency with a kernel-held
exclusive transaction. Its database inode and permanent versioned
`writer.lock` fence remain in place across restart. Process death releases the
kernel lock; it does not authorize deleting the fence or database. A second
writer is refused even when Pods overlap on a single-node ReadWriteOnce PVC.
Missing or changed ownership objects require operator recovery.
Kubernetes permits multiple Pods on one node to use a ReadWriteOnce volume;
the access mode does not provide writer exclusion. See
[persistent-volume access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).

The store restores only the expected fsGroup expansion of an owned private
inode, through an open descriptor, then revalidates its device, inode and path.
It retains private 0700 directories and 0600 files. Unexpected permissions,
owners, groups, symlinks and hard links remain errors.

A store initialization failure leaves safe RPC capabilities running and records
a recovery-required download state. Caller workspace binding remains in force.
Managed shell execution keeps the verified caller root and continues; it cannot
fall back to the Host's shared workspace. A store whose initialization
succeeded is available. It becomes unavailable only afterwards, when a ledger
persist fails or writer ownership is lost. The periodic cleanup lifecycle then
stops, and the runtime logs the error `GFS download store is no longer
available; periodic cleanup stopped and managed GFS operations are disabled`.

Verified contention with an active v2 writer and a valid unchanged ledger is a
temporary state. The runtime retries that case up to 60 times at two-second
intervals. Missing, legacy, corrupt or changed ownership is not a transient
retry condition. Retry and cleanup use one supervised lifecycle, so a slow
operation cannot overlap another or be lost from the shutdown join. Cleanup
starts after successful acquisition, including acquisition after retry.
Shutdown cancels scheduling, joins outstanding work and closes held writer
ownership even when delivery is unavailable.

Reuse verifies the checksum of one retained completed copy under store
serialization; its cost is the size of that one copy.
Startup reconciliation hashes every retained completed copy of every caller, so
its cost is bounded by the Host budget, 1024 MiB by default
(`MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`). This correctness check has not been
benchmarked on every supported PVC.

A pending task pin can survive a Host restart and protect bytes beyond TTL.
If the task never resumes, use the operator inventory and exact terminal-owner
recovery protocol. A time limit or cache pressure cannot prove that owner is
unused. Monitor bounded counts and retained bytes; do not label metrics with
owner or caller IDs.

Execution safety binding is independent of delivery eligibility and of store
availability. Cron, internal and approval-disabled tasks associated with this
store cannot obtain a shared-root shell, during recovery or otherwise. Trusted
system tasks use the existing system workspace contract; a missing verified
root denies spawning.
Healthy unattended execution keeps its existing policy, while large workspace
delivery still requires its attended caller and approval capability.

## Metrics

The global `/metrics` endpoint exposes fixed-cardinality instruments:

- `clerum_gfs_download_admissions_total{outcome}`
- `clerum_gfs_download_transfers_total{outcome}`
- `clerum_gfs_download_duration_seconds`
- `clerum_gfs_download_active`
- `clerum_gfs_download_quota_total{scope,reason}`
- `clerum_gfs_download_expiry_total{outcome}`
- `clerum_gfs_shell_output_limits_total{outcome}`
- `clerum_gfs_legacy_processing_leases_discarded_total` (counter of legacy
  processing leases whose discard at initialize was persisted; an unconfirmed
  discard is logged with outcome `unknown` and not counted)
- `clerum_gfs_download_store_quarantined_records` (gauge, no labels: GFS
  download store records currently quarantined, set at each initialize after
  reconcile; they stay charged to quota. Operator recovery reclassifies only
  copies whose content still matches their recorded hash; any other
  quarantined copy stays charged, and the operator recovery tool cannot
  release it.)

Labels contain bounded enums only. Caller, resource, download, command, path, correlation IDs, filenames, credentials, and raw output are prohibited as metric labels.

## Rollout and rollback

1. Apply the ConfigMap environment values through the supported HCC rollout. Updating a ConfigMap alone does not update an existing Pod.
2. Verify the new values and `/metrics` endpoints from newly created Hosts.
3. Before a writer-policy transition, hold the owned runtime mutation lease,
   stop the old Host and its executors, and prove they cannot mutate the store
   for the entire transition. An absent legacy `writer.lock` is insufficient:
   old empty-file execution leases were not durable. Existing legacy stores
   therefore require an explicit operator transition; a genuinely new empty
   store may initialize directly.
4. To roll back, retain the versioned writer fence and database, ledger and
   `.gfs-downloads`. An older image that does not understand the fence must
   refuse writing. Removing that protection to run an older image requires the
   same explicit physical fence and reviewed inventory; an image rollback
   alone does not authorize the ownership transition.
5. Cleanup or compaction during rollback requires separate operator authorization and a usage receipt. Do not treat an image rollback as permission to erase retained copies.

If limits are lowered, existing retained copies remain charged and new admissions are rejected until usage falls below the new policy.

### Records quarantined by builds before the #1022 fix

A build before this fix quarantined every record on any boot whose ledger held
a processing lease from an earlier writer session, including intact completed
copies. The fixed build discards the leases but does not reclassify those
records. A quarantined record is never expired and never evicted, and it stays
charged to quota. The defaults are 8 files (`MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES`)
and 256 MiB (`MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES`) per caller, and 64
files (fixed) and 1024 MiB (`MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`) per Host.
Pressure eviction cannot free them. A caller whose quarantined records alone
fill its limit gets `caller_quota_exceeded` on every new download; once
quarantined records alone fill the Host limit, every caller gets
`host_quota_exceeded`.

After the first rollout of the fixed build:

1. Read the startup warning `GFS download store holds <N> quarantined
record(s) charged to quota` and the gauge
   `clerum_gfs_download_store_quarantined_records`. N is the number of
   quarantined records in the ledger after startup reconciliation; it includes
   records the old build quarantined and any copy this boot found altered or
   unfinished.
2. Compare N, and the bytes those records hold, with the quotas above before
   running any GFS download check. A caller already at a limit fails every new
   download until its quarantined records are released.
3. To release them, run the
   [explicit operator recovery protocol](#explicit-operator-recovery-protocol)
   under a physical fence. With no lease left in the ledger, every quarantined
   record whose published copy still matches its stored size and checksum
   returns to `completed`, and partial copies without a checksum can be
   selected for removal. A record whose content no longer matches its checksum
   stays quarantined and charged (step 5).

## Explicit operator recovery protocol

The local operator module exports `inspectGfsStoreRecovery` and
`recoverGfsStoreUnderPhysicalFence`. It is not a Host RPC or model tool.
Inspection returns reviewed ledger, writer-fence and source-inventory SHA-256
values, counts and bounded opaque selection IDs. It does not return source
contents, filenames, caller identities, commands or credentials.

1. Resolve the exact Host workspace PVC, immutable workload identities, runtime
   context and mutation-lease owner. Inventory every consumer of that PVC,
   including terminating workloads and executors whose original Pod metadata
   may have disappeared.
2. Establish physical executor and writer settlement under an exclusive runtime
   fence. Replica count, API Pod absence, PID reuse, time limits and SQLite lock
   acquisition alone cannot establish it. Keep that fence active through the
   whole operation and recheck it before filesystem effects.
3. Inspect and review the three hashes and exact selection IDs. Unknown or
   unjournaled caches fail inventory even with an empty ledger. Select only
   task owners proved terminal and explicitly approved unused partial copies
   (`removablePartialIds`). Select every legacy processing lease listed in
   `processingLeaseIds` as settled. Since #1019 no executor holds a processing
   lease, and a current Host discards any legacy lease at initialize, so a
   legacy lease protects nothing once the fence of step 2 holds. A ledger
   inspected after a current Host has opened it has no leases, and the list is
   empty.
   Leaving any lease unselected sets every record to `quarantined`, including
   intact published copies, and writes the remaining leases back to the ledger.
   The next Host discards those leases but keeps the quarantine, and every
   retained copy stays charged until a second fenced recovery run.
4. Call `recoverGfsStoreUnderPhysicalFence` with those expected hashes,
   `settledProcessingLeaseIds` (every ID from step 3, or `[]` when the ledger
   has none), optional `terminalReceiptOwnerIds` and
   `removeSettledTransferIds`, and the real `withPhysicalFence` provider.
   A constant successful callback or an environment flag is not a provider.
5. Verify the returned before/after receipt and preserved published copies.
   When no lease remains, a record whose published `source` matches its stored
   size and checksum becomes `completed` and reusable, whatever its previous
   state, including `quarantined`. Every other record becomes or stays
   `quarantined`. Only an exact verified partial directory can be removed: a
   record that is not `completed`, has no stored checksum and has no published
   `source`. Its charge is released after positive absence. A published
   `source` remains protected even when a crash left its ledger entry without a
   completed state or checksum.
   Recovery cannot release a quarantined record that keeps a checksum its
   content no longer matches, or whose published `source` is gone: it neither
   reclassifies it nor accepts it for removal (`invalid_selection`). The
   operator module has no path that releases that charge.
6. Reopen the Host on the same retained PVC. Prove availability, authenticated
   reuse, source/version equality and quotas before restoring ordinary traffic.
   On interruption, preserve the last receipt and accounting objects, obtain a
   new inventory and repeat the physical proof. Do not blindly remove the
   sentinel, database or remaining copies.

An inherited v2 store can be delivery-disabled while still holding its kernel
writer lock. Its old main process must settle before an operator maintenance
executor can acquire that writer. A legacy early-initialization failure does
not hold the new lock. These are different transitions.

For an owned single-node Minikube profile, a contained node stop/start can be
part of the proof only after every prior PVC consumer is proved unable to escape
the node PID namespace and restarted consumers are certified to run the new
recovery-disabled code. Preserve the profile and PVC, use the supported
`branch-profile-stop`/`branch-profile-start` entry points, and verify immutable
node-container termination and restarted workload identities. Stopping and
restarting alone is insufficient. The generic module does not provide an
automatic Kubernetes fencing implementation; source tests do not certify this
live runtime proof.
The conditional containment argument uses Linux's termination of a PID
namespace when its init exits; it still requires evidence that the old
executors could not escape that namespace. See
[PID namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).
