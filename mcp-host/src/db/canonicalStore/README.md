# Canonical conversation store

This module owns the SQLite/layout transition on one explicitly bound PVC. It uses
`better-sqlite3` from the existing Host dependency set. It does not authenticate
HTTP callers, establish a maintenance barrier, or deploy a Host.

## Writer and boot integration

Import the public API from `db/canonicalStore/index`.

1. In the actual database worker, acquire `acquireWriterFence({ stateDir })` before
   opening writable SQLite. Keep this dedicated connection for the worker lifetime.
2. Call `assertNoIncompleteCanonicalMigration({ stateDir, root? })`, then
   `validateCanonicalStore({ stateDir, binding, root? })`. The latter requires an
   existing file, supported schema, exactly one immutable identity, and the binding.
3. Open the existing writable store and run its ordinary migrations. Call
   `fence.assertHeld()` immediately before admitting or executing every write.
4. Drain and close the writable store before closing the fence. A failed assertion
   must close admission; reacquisition cannot rescue an already admitted write.

`Binding` is `{ hostUid, pvcUid }`. When only the state subPath is mounted, omit
`root`; the worker validates the identity and active state journal. The init sees
both subPaths and verifies the complete root marker and archived operation.
`assertLegacyLayoutAllowed(root, binding)` rejects a root mount of a canonical PVC.

The fence database is `state/.canonical-store/writer-fence.db`. It uses DELETE
journal mode and holds `BEGIN EXCLUSIVE`, without a heartbeat or TTL. Never remove,
replace, or rename it. Lock contention is `WriterFenceBusy`. Local two-process
proof is distinct from proving lock reliability on the deployment storage driver.

## Layout transition

`runMigration(root, { binding, fs?, fence?, provenance? })` acquires its own fence
unless the caller supplies the fence already held by the runtime. `layoutPrecheck`
uses the same engine but creates no identity; a winning `C_state` remains intact.

The Phase A `legacy-floor` contract uses the same `workspace` and `state` subPaths,
`state/state.db`, and the state-local writer fence. It does not opt the Host into
canonical identity. A successful floor commits correlated binding/layout/migration
records at `.clerum-canonical-store-legacy` and
`state/.canonical-store/legacy-layout.json` before its shared journal is completed.
`validateLegacyStore({ stateDir, binding, root? })` is the worker guard under the
held fence. It requires an existing supported DB, no canonical identity, the bound
state-local record and its completed floor archive. Migration 016 may exist with an
empty identity table. When the full root is available it also checks the matching
root record. Before completing, the engine durably creates both subPath directories,
including an empty workspace. Normal full-root boot requires that directory and does
not recreate it. `legacyBootCheck` requires the existing fence and never creates,
normalizes, chooses a candidate, or repairs metadata. Normal full-root boot rejects root/workspace SQLite lineages and unconsumed imports;
maintenance current/recovery proof may inspect the prepared import separately. Stable floor boot checks do
not hash conversation history; later accepted writes remain valid.

A floor cannot be created from missing files or an untrusted provenance assertion.
Empty creation needs the distinct authenticated newly-provisioned-PVC floor
capability. Retained operation directories, archives, markers, imports and backups
block an empty/new inference. Ordinary legacy root mounts reject a committed floor.
Canonical activation subsequently snapshots the floor's current accepted catalog,
adds the immutable identity, and preserves the floor records and archive. It does
not repeat workspace relocation. A canonical identity permanently rejects floor
boot or downgrade.

The active journal is `state/.canonical-store/journal.json`. Retained sources,
private normalization scratch, staging, retired originals, and the archived journal
live under a random UUID operation directory. The engine persists intent/done per
SQLite file and workspace entry and synchronizes both directories after renames.
Only its own real, unpromoted staging can be reset. Normalized copies return an explicit
private-scratch disposal capability. Consumers close SQLite and release that scratch
in finally; published imports, snapshots and retired originals remain retained. Evidence and original candidates
are retained. No selection uses mtime, size, or a partial conversation hash.

A new database requires explicit `NewStoreProvenance` (`new-host` or
`verified-empty-sqlite`) bound to the Host/PVC and maintenance operation. Missing
files, a memory store, unknown store mode, backups, or retained previous history do
not prove a new Host. Active journals and incomplete markers block normal boot.

Canonical identity is installed by migration 016 in staging before the writer
opens it. Updates/deletes are forbidden by SQLite triggers. A stable rerun checks
identity and the final marker, and accepts later legitimate writes without comparing
DB bytes against the original staging hash.

## Inspection, export and recovery

`inspectCandidate` requires an already held fence for cold inspection. It keeps raw
snapshots untouched, copies DB/WAL/SHM/journal to private scratch, validates schema,
integrity, foreign keys and FTS, and normalizes known migrations there. Catalog
hashing streams all business columns and SQLite sequence values with type/NULL
sensitivity. Identity, FTS data, and migration timestamps do not establish legacy
catalog equivalence. Unsupported schema and non-empty rollback journals block.

Diagnostic `inspect` (including `--live`) uses a readonly source connection and Online Backup API. Its file
hashes describe the consistent backup, not concurrent source/SHM bytes. It cannot
prove the absence of later writes or authorize a cutover.

`exportCanonicalStore` requires maintenance and uses a held runtime fence when
supplied. Publication is exclusive and the manifest pins binding, catalog, source
identity and retained bytes. A repeated exportId returns the same receipt only when
source business content/identity still agree. A changed source requires a new ID.
Consumed imports remain bound to their completed journal and retired original set.

`adoptCanonicalStore` only continues the same `DivergentCandidates` journal in
`snapshotted`, with an `OperatorAuthorization` capability distinct from untrusted
request metadata. The caller authenticates the operator and verifies maintenance;
annotations alone cannot construct this capability. Consumption/receipt is durable
before normal writer admission. Replays return the existing receipt without a new
promotion; stale binding/manifest/request IDs block.

For a canonical store, ordinary migration keeps rejecting all foreign candidates.
`inspectRecovery(root, C_import:<uuid>, options)` proves an externally reconciled
source retains current accepted writes and returns proposal pins. `beginRecovery`
requires those pins, the exact current store ID/catalog hash, and trusted operator
authorization. It preserves the current DB and previous marker as evidence and
keeps the store ID. No automatic merge occurs. Missing or changed current rows,
approval additions/removal, sequence regression, or an unvalidated current catalog
block before a recovery journal starts. Every authoritative current session column remains exact. Only message_count, turn_count
and last_activity_at may be derived again using the verified native recompute predicate
over all candidate messages. Activity is exactly the maximum of the current accepted persisted watermark, started_at
and all candidate message timestamps; new sessions derive exactly from started_at and
messages. An invented higher watermark is rejected, as is a regression. Ownership, state, models, token accounting,
budgets, tasks and approvals remain exact.

`discoverBackupSets` groups historical `.pre-<suffix>.bak` files by the exact shared
suffix, including their WAL/SHM/journal. They are never automatic candidates.
`exportHistoricalBackup` requires an operator capability and exact source-set hash,
retains the original set and creates a validated import. Selecting it remains a
separate recovery operation with the same accepted-write continuity proof.

## Operator CLI

Run the compiled `dist/db/canonicalStore/cli.js` using the image's existing Node and
SQLite dependencies. Every command requires `--root`, `--host-uid`, `--pvc-uid`.

- `inspect [--live] [--scratch-root <existing-writable-root>]`: readonly Online Backup,
  hashes/counts, blocked-journal request pins and backup inventory. The default scratch root is the real OS temporary
  directory; this creates no state directory or fence in the source PVC. Unreadable WAL
  or SHM fails closed. Recovery proof inspection separately requires maintenance and a fence.
- `inspect --recovery-import-id <uuid>`: prove prepared recovery and return pinned proposal fields.
- `layout-precheck --storage-contract legacy-floor --request-id <uuid>`: authenticated floor layout transition without identity creation. Local flags cannot authorize it.
- `migrate --request-id <uuid>`: fresh authenticated prepare Job; creation requires its
  distinct newly-provisioned-PVC capability, never a local provenance flag.
- `export` rejects with AdoptUnauthorized. Use the reviewed verified-bootstrap/shared-library
  invocation; local flags never create an export capability. Historical backup export remains
  an explicit trusted programmatic operation.
- `adopt --storage-contract canonical|legacy-floor --request-id <uuid>`: resolves the authoritative admin request. An optional
  reserved request JSON must exactly match that request and is only a hint. Recovery requests include `expectedStoreId`
  and `expectedCurrentCatalogHash`; floor recovery pins `expectedMigrationId` and the current hash without a store ID. Ordinary blocked-journal adoption requests omit these current-state pins.

This CLI is an authenticated operator entry point in the caller's security domain.
Its flags do not authenticate a tenant or convert metadata into operator authority.
Mutation commands emit one bounded JSON init outcome. Named reasons/exits are defined
once in `REASON_EXITS`; unclassified failures remain exit 1 without sensitive output.

## Limits and evidence

The implementation bounds candidates (64), workspace tree entries (20,000), source
bytes (64 GiB), JSON (8 MiB), and streaming/backup progress budgets (120 seconds).
It reserves eight source sizes plus 16 MiB before snapshot work. Filesystem and
synchronous SQLite integrity calls still require an external operational deadline;
JavaScript cannot interrupt a synchronous SQLite call already in progress.

Real SQLite tests cover full-field divergence, known/unknown schemas, non-checkpointed
WAL, FTS corruption, explicit creation, two-process fence competition/process death,
per-file intent/rename/fsync/done cuts, workspace trees, partial staging, adoption,
export retention, and prepared recovery continuity. These checks do not certify
legacy producer drainage, real storage-driver locks, Kubernetes runtime, UI flows,
Desktop packaging, image floors, or T0/T1/T2. Those are separate integration lanes.

Operator flags are caller inputs. They do not authenticate a tenant. The caller must
verify operator RBAC, Host/PVC scope and fresh durable maintenance before constructing
a capability or invoking mutation. An approved shell under the same UID retains its
existing authority; filename filters are exposure controls and do not sandbox that shell.

Recovery reserves its exact request, pins and migrationId in a durable started allocation
intent before creating the operation directory. Retry accepts only that reserved empty
directory with expected owner/permissions, then records its physical identity before
marker/copies. Unknown preexisting directories remain untouched. Canonical recovery
requires an already relocated workspace; pending root entries fail before journal start.
A caller borrowing the runtime fence must serialize operations on that capability.

Physical operator proof APIs: verifyPreparation validates prepared source/export/retained
bootstrap snapshots using readonly source access and external scratch. It returns only
measured binding/hashes/schema; newly-provisioned and process-closure authority remain
with the fresh Kubernetes/operator verifier. verifyCurrent uses the actual held runtime
fence or runs only after independently verified writer shutdown, and returns the current
catalog hash plus the completed migration marker/manifest/candidate pins. Created has no
candidate and omits that field. CLI commands verify-preparation and verify-current take
maintenance-id and binding, with optional request-id/controller-uid/capability-id correlation
DATA. source-class is sqlite-pvc/sqlite-external-exported/new-host; memory/unknown block.
Bootstrap-backed preparation must use sqlite-external-exported and pins objectHash of its
ExportManifest; sqlite-pvc pins the journal-shaped candidate plus workspace manifest.

Normal Pod init runs boot-check only. It acquires the existing coordination fence and
checks committed marker/identity/schema/archived journal. It cannot create a DB, normalize,
promote, repair a marker or take an operator grant. Missing DB/fence or active journal
blocks. Canonical creation/migration/adoption belongs to authenticated controller Jobs,
including a distinct newly-provisioned-PVC initialization capability.

Operator CLI mutation/verification resolves fresh in-cluster requests and distinct action
capabilities by default. Request files and principal/provenance/authorization flags are
only matching hints; none creates authority. The actual Job full-PVC root mount must
match the CLI root before the operation. Only named programmatic test boundaries can
inject a resolver. Export authority belongs to the separately verified bootstrap invocation.

Final CLI action mapping: prepare/verify-preparation is a readonly physical-proof Job;
prepare/migrate is a distinct authenticated mutation Job and rechecks the controller-pinned
physical manifest while holding the same fence through migration. New-host creation uses
only its verified provisioning capability. prepare or adopt/verify-current is a completing
finalization Job tied to the actual successful mutator Job/outcome storeId; it measures the
new current hash rather than trusting a pre-mutation hash. release/verify-current separately
checks the ready layout and API-pinned storeId/current hash. All operator commands require
request-id and the actual projected Pod/Job/Host/PVC chain; flags cannot substitute.

Authenticated migrate retries first match the active journal or completed marker/archive
against the durable operator request context: requestId, maintenance, principal, full
authoritative request hash, verified preparation hash, source class and original new-host
provisioning. The first started record stores this context before any snapshot. Matching
continuation skips a fresh preparation inventory and resumes the same durable decision;
partially retired originals are not reclassified. Completed retries validate identity and
marker and preserve legitimate later writes. Foreign or unbound journals cannot acquire
operator authority merely through the same Host/PVC IDs. Pod/Job replacement metadata is
revalidated by the fresh resolver and is not pinned into the logical operation context.

Legacy operator capability kinds are distinct for preparation verification, migration,
new-PVC initialization, finalization, release verification and adoption. CLI results
include the explicit storage contract and hash of the fresh authoritative request,
not a hash flag. Successful mutators measure the final `catalogHash` under the same
held fence; finalization and release physically compare the pinned current hash.
The request binds the logical operation while a replacement Job/Pod is independently
revalidated by the resolver. A matching interrupted floor mutation resumes exactly
its shared `layout-precheck` journal; a foreign context cannot continue it.

Physical sqlite-pvc preparation verifies every supported candidate and the complete
workspace manifest. An intact divergent inventory returns `InventoryVerified` with
`candidateDisposition: divergent` and its exact manifest hash; it does not claim a
selected source/catalog hash. The authenticated mutator revalidates that unchanged
inventory under its fence and persists `DivergentCandidates` in the shared journal.
Only exact authorized adoption continues that journal, preserving its writer and
retaining every original. Preparation is never a successful layout transition.

`inspectLegacyRecovery` and `beginLegacyRecovery` reuse the canonical accepted-write
continuity predicate and per-file journal. A completed floor recovery pins the old
migration ID and current catalog hash, preserves both previous floor records with
individual durable move intents, and installs no identity. Missing accepted rows,
changed authoritative session/approval state and sequence regression reject the
candidate. One-shot receipts are bound to the same request/principal/migration;
later accepted writes cannot cause a replay to replace the current database.
