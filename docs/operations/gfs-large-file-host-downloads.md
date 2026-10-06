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
| `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES`     |          `8` |                `64` | Retained completed files per caller.      |
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
them. Reuse adds an owner without replacing another task's pin. A terminal task
releases its pin only after its executions settle. A positively absent copy may
release its charge; corrupt or ambiguous copies remain charged until recovery.
A replacement needs fresh GFS authorization.

After a clean v2 writer restart with no unknown inherited execution, pins alone
do not disable delivery. Fresh remote authorization and source version, size,
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
- A processing lease is acquired after approval and before the child process is created. Integrity checks precede its processing budget, and file expiry, lease expiry and shutdown are rechecked after durable admission. If admission becomes unavailable, it is rolled back and no process starts.
- The lease is released only after process-group termination and output settlement. A live execution protects its copy even if the durable deadline has elapsed; a timer alone does not prove physical termination. If release fails, the result is an error and cleanup protection remains.
- Every execution lease is durable, including a command admitted before any
  download exists. Recovery retains inherited executions and their protected
  copies until physical settlement is proved. Neither a deadline, a PID probe
  nor acquisition of the writer lock proves that a detached child terminated.
  Unknown inherited executors disable managed downloads and execution for the
  whole Host because Stage 1 executors share one UID. A failed admission rollback
  remains charged when persistence is uncertain; it does not invent a running
  execution.

Unix directory modes and random directory names do not provide cross-caller OS isolation when a Host shares one UID. Approved arbitrary shell access remains a documented Stage 1 residual; stronger executor isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before releasing a processing lease. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

Generic workspace tools reject direct and symlink-resolved access to `.gfs-downloads` through `file_read`, `file_write`, memory read/write, list/tree, and search. This prevents accidental dumps; it does not revoke access from an explicitly approved shell command.

## Retention, quotas, and recovery

- Completed copies have a configured maximum retention time, seven days by
  default. Active executions and task receipt pins protect a copy past its TTL
  until the consumer physically settles.
- Host and caller quotas account for partial and completed files. Unknown or corrupt accounting fails closed rather than reporting zero usage.
- A new store publishes an atomic schema-1 ledger before accepting transfers. Every existing ledger is parsed, including empty content; invalid record or lease maps are rejected.
- A pre-existing store directory with a missing ledger is unknown accounting, including an interrupted first initialization before ledger publication. Startup rejects it and preserves retained bytes for operator recovery instead of silently resetting quota. This can require recovery after a bootstrap interruption.
- Startup does not reconstruct an accounting directory deleted in its entirety while caller copies remain. Approved shell commands share the Host UID and can destroy this state; whole-store deletion remains outside the recovery guarantee and requires operator inventory of retained copies.
- Admission may evict the oldest verified completed copies that have no active
  transfer, execution lease or task receipt owner. The complete eviction plan
  must satisfy both Host and caller quotas before any copy is removed. An
  impossible or invalid request cannot evict another caller's files. Active,
  pinned, inherited, corrupt and ambiguous entries are never pressure victims.
  Quota limits still reject a request when no safe complete plan exists.
- Only positively identified expired or pressure-evictable entries are deleted.
  Quota charges are released only after positive filesystem absence. A cleanup
  failure remains charged and is observable for recovery.
- Startup reconciles the ledger and partial files before the capability is advertised.
- Shutdown stops new admission, drains active work where possible, and leaves unproven lease/recovery state protected.
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
Managed shell execution fails before spawning a process; it cannot fall back to
the Host's shared workspace or omit the processing lease.

Verified contention with an active v2 writer and a valid unchanged ledger is a
temporary state. The runtime retries that case up to 60 times at two-second
intervals. Missing, legacy, corrupt or changed ownership is not a transient
retry condition. Retry and cleanup use one supervised lifecycle, so a slow
operation cannot overlap another or be lost from the shutdown join. Cleanup
starts after successful acquisition, including acquisition after retry.
Shutdown cancels scheduling, joins outstanding work and closes held writer
ownership even when delivery is unavailable.

Execution safety binding is independent of delivery eligibility. Cron,
internal and approval-disabled tasks associated with this store cannot obtain
an unleased shared-root shell during recovery. Trusted system tasks use the
existing system workspace contract; a missing verified root denies spawning.
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
   executions proved settled, task owners proved terminal, and explicitly
   approved unused partial copies. The default preserves copies and charges.
4. Call `recoverGfsStoreUnderPhysicalFence` with those expected hashes,
   `settledProcessingLeaseIds`, optional `terminalReceiptOwnerIds` and
   `removeSettledTransferIds`, and the real `withPhysicalFence` provider.
   A constant successful callback or an environment flag is not a provider.
5. Verify the returned before/after receipt and preserved published copies.
   Only an exact verified partial directory can be removed; its charge is
   released after positive absence. A published `source` remains protected even
   when a crash left its ledger entry without a completed state or checksum.
   Verified copies with their original checksum can become reusable after all
   unknown executions settle; corrupt copies remain charged and quarantined.
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
