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

If a surface has no caller-bound workspace/download capability, an admitted source is reported as `workspace_delivery_unavailable`; MCP Host does not fall back to returning an oversized body.

## Approval and local processing

For an available GFS file reference above 8 KiB, the Host prepares the workspace
copy after the durable turn starts and before its first model request. It uses
the same caller-bound `clerum__gfs_download` and effective approval controller as
the interactive tool flow. If download approval is required, no copy is prepared
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
transfer or quota reservation. A missing or corrupt copy remains charged and
unavailable until recovery; a replacement needs fresh GFS authorization.

`shell_exec` remains the trust boundary:

- The working directory and `HOME` are the caller workspace. A supplied allowlisted or dynamic `HOME` cannot relocate execution outside it.
- Each command requires live user approval.
- Combined retained command output is bounded to 1 MiB. Live progress is bounded to 64 KiB. Exceeding the output bound terminates the process group and returns a truthful `output_limit_exceeded` result.
- A processing lease is acquired after approval and before the child process is created. Integrity checks precede its processing budget, and file expiry, lease expiry and shutdown are rechecked after durable admission. If admission becomes unavailable, it is rolled back and no process starts.
- The lease is released only after process-group termination and output settlement. A live execution protects its copy even if the durable deadline has elapsed; a timer alone does not prove physical termination. If release fails, the result is an error and cleanup protection remains.
- Recovery without a live owner conservatively retains leases until their bounded deadline rather than assuming that a child died with the Host. A failed admission rollback retains its durable reservation until that deadline without registering an execution that never started.

Unix directory modes and random directory names do not provide cross-caller OS isolation when a Host shares one UID. Approved arbitrary shell access remains a documented Stage 1 residual; stronger executor isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before releasing a processing lease. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

Generic workspace tools reject direct and symlink-resolved access to `.gfs-downloads` through `file_read`, `file_write`, memory read/write, list/tree, and search. This prevents accidental dumps; it does not revoke access from an explicitly approved shell command.

## Retention, quotas, and recovery

- Completed copies expire after the configured TTL, seven days by default.
- Host and caller quotas account for partial and completed files. Unknown or corrupt accounting fails closed rather than reporting zero usage.
- A new store publishes an atomic schema-1 ledger before accepting transfers. Every existing ledger is parsed, including empty content; invalid record or lease maps are rejected.
- A pre-existing store directory with a missing ledger is unknown accounting, including an interrupted first initialization before ledger publication. Startup rejects it and preserves retained bytes for operator recovery instead of silently resetting quota. This can require recovery after a bootstrap interruption.
- Startup does not reconstruct an accounting directory deleted in its entirety while caller copies remain. Approved shell commands share the Host UID and can destroy this state; whole-store deletion remains outside the recovery guarantee and requires operator inventory of retained copies.
- Only positively identified expired entries are deleted. A cleanup failure remains charged and is observable for recovery.
- Startup reconciles the ledger and partial files before the capability is advertised.
- Shutdown stops new admission, drains active work where possible, and leaves unproven lease/recovery state protected.
- Pending and queued admission rechecks shutdown after asynchronous validation and persistence. Shutdown rechecks active ownership before releasing the writer lease.

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
3. Before a writer-policy transition, disable new downloads, drain transfers and leases, and prove old Host/child processes cannot mutate the store.
4. To roll back, restore the prior image/config without deleting `.gfs-downloads`. A rollback-compatible Host preserves the ledger and quota charges.
5. Cleanup or compaction during rollback requires separate operator authorization and a usage receipt. Do not treat an image rollback as permission to erase retained copies.

If limits are lowered, existing retained copies remain charged and new admissions are rejected until usage falls below the new policy.
