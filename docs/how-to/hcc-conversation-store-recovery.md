# Conversation-store preparation and recovery

#825 preserves one SQLite store through stateful, stateless and Desktop transitions. Merging its code does not authorize a rollout, export, adoption or production operation.

## Authority and maintenance

Use the ordinary Control UI login and its HttpOnly admin session for the admin conversation-store routes. The API derives the control-admin principal from the session and current membership. Bearer authentication, a principal in a request body, an annotation and a local `authorized` flag cannot authorize recovery. Cookie jars, credentials and service-account material must never enter proof files, receipts or logs.

Request maintenance through `/api/v1/admin/hosts/:hostRef/conversation-store/maintenance` with the current Host/PVC binding and a fresh request ID. `requestResult=completed` means the intent is latched; `maintenance.phase=quiescing` remains active. It does not mean admission has reopened. Wait for the runtime to finish accepted work, preserve live approvals, stop background producers and acknowledge worker closure. The report is written at `STATE_DIR/.canonical-store/maintenance/maintenanceId/podUid.json`.

The report is untrusted evidence. HCC sends its reviewed verifier over authenticated Kubernetes Exec. It validates fresh named Host status and the source Pod identity through [SelfSubjectReview](https://kubernetes.io/docs/reference/kubernetes-api/definitions/self-subject-review-v1-authentication/), then recomputes PID, start ticks, executable, script, UID1001, effective SQLite configuration, open database handles, the actual same-PVC exclusive fence and the complete catalog. A forged report while a writer holds the fence must fail. Filesystem ownership or an ACK-shaped JSON body cannot advance the controller state.

HCC verifies the source Pod owner chain, current image ID, restart count and PVC mapping before and after Exec. The executable is an absolute image-contract path; Exec clears Node preload/module overrides. It does not execute a tenant-writable temporary verifier. The standard image ABI uses `/usr/local/bin/node`; Desktop uses `/usr/bin/node`. An old image without a verified ABI or supported closure protocol remains blocked.

## Supported export and legacy limits

`scripts/conversation-store/bootstrap-export.mjs` runs as UID1001 inside the same source Pod. It uses fresh Kubernetes authority and the shared compiled SQLite engine; it does not install packages or invoke an unauthenticated migration CLI. The HCC-generated invocation supplies actual Host name/namespace/UID, PVC UID, Pod UID, maintenance request ID, maintenance ID, export ID, source path, state mount and PVC root. These values come from current API objects and runtime mounts, not fixed examples or tenant annotations.

The supported path keeps the main process alive and its database worker closed under maintenance. PID1 is therefore supported only with the modern acknowledged-worker-exit protocol, immutable application/core dependencies and successful physical checks. Killing PID1 to protect an off-PVC store would destroy that filesystem and is prohibited.

Old `50-mcp-host-service` launched an unsupervised background child and made `/app` writable. Old shutdown caught drain errors and could still exit zero. SIGTERM, a missing PID, exit zero or SIGSTOP alone does not prove accepted writes drained. Those images remain blocked unless an independently verified accepted-write oracle and compatible closure mechanism establish the missing proof. The new supervisor never relaunches its child and preserves application immutability; installing it is not evidence that an older source was protected before its first rollout.

Memory, dual/RAM-primary and unknown modes require a supported live export of their complete state. Absence of a SQLite file never means empty. A retained PVC is not positive new-Host provenance. No recovery flag may mint that provenance.

## Export artifacts

An export retains the original SQLite set and recognized historical backup files without opening the originals in SQLite. Replay, normalization and backup run only on a fresh private clone outside the PVC. Original file hashes are checked again before publication. A non-empty unsupported rollback journal, symlink, hardlink, changed source, insufficient space or unsafe scratch path blocks without replacing originals.

The strict import manifest is published exclusively at `.canonical-store-import/exportId/manifest.json`. Its schema, full normalized catalog hash, binding and published file fingerprints are those of the shared engine. The bootstrap receipt is separate:

- `.canonical-store-bootstrap/exportId/receipt.json` records the original maintenance request, binding, source Pod, source/backup hashes, import manifest hash and measured closure hashes.
- `sources/` retains the original DB/WAL/SHM/journal bytes; `backups/` retains recognized grouped backups.
- `runtime-closure.json` and `closed-facts.json` retain evidence whose hashes HCC pins through its authenticated fresh measurement.

Artifacts remain UID1001 data and are not authority by themselves. A read-only verifier Job independently checks raw retained hashes, supported schema, full normalized catalog, import bytes and binding. Repeating the same export ID returns the same valid receipt only for identical source and binding; changed or divergent content blocks. Export staging is disposable; retained originals and receipts are not.

Submit `prepare` only after the export and an isolated restore rehearsal pass. This creates a new current request ID while the original maintenance ID stays latched. Fresh source Exec validates that request separately from the receipt's original maintenance request. HCC admits the intended image/template only after both physical source and read-only artifact verification succeed.

## Image and runtime gates

Acquire and build images only through the documented Make/T2 path and its live branch-profile lease. `scripts/conversation-store/verify-images.sh` validates the inherited lease, requires an explicit local Docker endpoint, uses an empty task-local Docker config and runs offline with `--pull=never`, UID1001, finite deadlines and private tmpfs. Missing images, invalid/empty proof output or zero verified images cannot pass. The default selection includes base, slim, full and Desktop.

The offline image contract exercises the compiled inspection CLI, SQLite ABI, shared-engine fixture migration, compiled boot-check, real worker startup, fence contention, acknowledged closure, preserved ownership/message IDs/approval state, a post-cutover write and stable boot. It does not claim a positive authenticated operator migration CLI; that is the in-cluster Job/API/T2 lane. Its database contains declared synthetic image-only fixtures.

G-IMG and Desktop container probes do not certify Desktop Host execution. G-DESK-R must use the real s6 entrypoint, UID1001 security context, actual PVC and application processes, API continuity and a post-cutover write. Rootless s6 support must be demonstrated; a root-only fixture or entrypoint override cannot stand in for it. Keep Desktop unactivated when that lane is unavailable.

T0, real PostgreSQL T1, runtime T2, API lifecycle integration and browser journeys remain separate receipts on the exact delivered HEAD. Docker/Minikube operations run outside the native sandbox. Operational logs and evidence belong under the ignored primary Evenfire `.local-notes/infra/runs/` tree, with no credentials or raw transcripts.

## Adoption and rollback

Inspect divergent candidates under maintenance and the shared fence. The authenticated operator authorizes one exact Host/PVC/migration/manifest/candidate decision. Use the one-shot `adopt` request; do not put reusable fingerprints in an annotation. Its request file is confined to `state/.canonical-store/requests/requestId.json`. Corruption, incompatible schema, foreign binding, changed inputs, lost fence or replay remain hard blocks.

Rollback software must preserve workspace/state subPaths, explicit SQLite/path/binding, required identity checks, compatible init/journal and the writer fence. Removing opt-in or deleting a Deployment never removes the durable commitment. Never restore root-layout/newest-source-wins code or an image that can silently create a missing database.

Prepare a compatible rollback release and rehearse it in isolation with a write accepted after cutover. A historical backup is not permission to overwrite current canonical state: retain the current store, compare the accepted-write delta and obtain an explicit reconciliation decision. Keep admission fenced and repair forward when a safe compatible rollback or complete delta reconciliation is unavailable.
