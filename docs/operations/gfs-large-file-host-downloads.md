# GFS large-file Host downloads

## Scope

MCP Host separates GFS source admission from visual model input:

- GFS admission defaults to **16 MiB** and can be raised to at most **200 MiB** only by an environment-approved deployment.
- Text at or below **8 KiB** may be returned inline.
- Larger admitted sources are transferred as governed workspace files. Their contents are not placed in the model conversation.
- Visual projection is decided by the effective provider/model/transport profile after local validation. It never defines the generic GFS source limit.
- PR #806's expected Grok visual profile is not materialized in this execution base: its installed attempt contract does not export visual limits. Grok GFS pixels therefore fail closed until that contract lands; when it does, its values are a provider visual profile, not a GFS transfer ceiling. PR #932's 11 MiB inline-document boundary is a separate Desktop composer policy and is also not a GFS transfer ceiling.

This fixes the reported 3,836,961-byte CSV case: the file is admitted under 16 MiB and delivered to the caller workspace for approved local processing.

## Effective limits

| Environment variable | Default | Ceiling | Meaning |
| --- | ---: | ---: | --- |
| `MCP_HOST_GFS_MAX_FILE_BYTES` | `16777216` | `209715200` | Largest GFS source admitted by MCP Host. |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES` | `1073741824` | deployment-approved | Aggregate retained download budget. |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES` | `268435456` | aggregate budget | Per-caller retained download budget. |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES` | `8` | `64` | Retained completed files per caller. |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY` | `1` | `2` | Simultaneous active transfers per caller. |
| `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS` | `168` | `8760` | Retention period for a completed copy. |

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

`shell_exec` remains the trust boundary:

- The working directory and `HOME` are the caller workspace. A supplied allowlisted or dynamic `HOME` cannot relocate execution outside it.
- Each command requires live user approval.
- Combined retained command output is bounded to 1 MiB. Live progress is bounded to 64 KiB. Exceeding the output bound terminates the process group and returns a truthful `output_limit_exceeded` result.
- A processing lease is acquired after approval and before the child process is created. It is released only after process-group termination and output settlement. If acquisition fails, no process starts; if release fails, the result is an error and cleanup protection remains for recovery.
- Expiry does not remove a copy protected by an admitted execution lease. Recovery conservatively retains leases until their bounded deadline rather than assuming that a child died with the Host.

Unix directory modes and random directory names do not provide cross-caller OS isolation when a Host shares one UID. Approved arbitrary shell access remains a documented Stage 1 residual; stronger executor isolation is separate Stage 2 work.

Shell cleanup signals and waits for the detached process group before releasing a processing lease. Operating systems may reuse a process-group identifier after the original leader has been reaped; Stage 1 narrows that window by signaling immediately on leader close, but stronger executor identity is required to eliminate it.

Generic workspace tools reject direct and symlink-resolved access to `.gfs-downloads` through `file_read`, `file_write`, memory read/write, list/tree, and search. This prevents accidental dumps; it does not revoke access from an explicitly approved shell command.

## Retention, quotas, and recovery

- Completed copies expire after the configured TTL, seven days by default.
- Host and caller quotas account for partial and completed files. Unknown or corrupt accounting fails closed rather than reporting zero usage.
- Only positively identified expired entries are deleted. A cleanup failure remains charged and is observable for recovery.
- Startup reconciles the ledger and partial files before the capability is advertised.
- Shutdown stops new admission, drains active work where possible, and leaves unproven lease/recovery state protected.

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
