# Recover password verification ownership

Member password login and Desktop password reverification use the persisted
`password_verification_work` singleton to bound actual bcrypt work across processes.
The slot has no expiry. Database connection loss, a missed heartbeat, capture expiry,
or a process restart does not prove that the old computation stopped.

A crashed owner or an ambiguous acquisition/release can therefore leave password
verification unavailable. Other authentication methods keep their existing policies.
Verified password-reset recovery also uses this singleton to bound password hashing,
but does not reserve the anonymous login pace. If the owner is busy or unavailable,
recovery fails closed and can be retried after the sanitized `Retry-After` interval.
Never clear this record from a request, cleanup job, startup hook, or automated
timeout. Do not reset the pace or identifier history to recover it.

See [password admission availability and monitoring](../operations/password-admission.md)
for the intentionally retained anonymous-login starvation tradeoff and its signals.

## Supported migration starting points

The Spec 092 migration is supported from an empty fresh database or from an existing admission
schema that has the durable `password_verification_work` owner and migration receipts for
`0126_bug192_password_admission` (including its registered historical alias),
`0127_password_evaluation_retention`, and `0128_password_work_ownership`. Schema objects alone do
not prove that the owner-aware migration transaction completed. If any required receipt is missing,
the v2 preflight fails before setting the rollout fence or applying pending migrations. Reconcile
the migration history through the approved owner-aware release path; do not manually invent or
insert receipts. With a supported existing admission state, the migration runner commits its
durable fence before changing the outcome-accounting schema. A fresh database has no prior
admission history or migration receipts to fence; the migration runner applies the ordered schema
before the API serves.

An existing database with migration receipts but without password admission state (before
`0126_bug192_password_admission`) is not treated as fresh. A pre-existing application schema with
missing or empty migration receipts is also not treated as fresh. The v2 startup fails before
migration because it cannot prove there is no old password verifier to fence. Use the owner-aware release
that applies migrations `0126_bug192_password_admission`,
`0127_password_evaluation_retention`, and `0128_password_work_ownership`; complete its `Recreate`
rollout and verify old verifier processes cannot resume before deploying the v2 release.

An existing database with `password_identifier_state` but without
`password_verification_work` (migration `0126_bug192_password_admission` or
`0127_password_evaluation_retention`) must not be upgraded directly by the
`0130_password_login_success_admission` verifier. Its preflight stops before applying pending
migrations because the missing owner
does not prove that an older verifier has stopped. Use the already-approved staged adoption: run
the ownership-aware release that applies migration `0128_password_work_ownership`, complete its
`Recreate` rollout and verify that older verifier processes cannot resume, then run the
`0130_password_login_success_admission` release. Do not skip the ownership-aware
stage, remove the preflight, or manually create the owner table. If process termination is
uncertain, leave password verification unavailable and escalate under the procedure below.

If migration `0130_password_login_success_admission` is interrupted after committing the
`draining` fence, retry the compatible migration path; the fence and admission history remain in
place. Do not downgrade to an older verifier or clear migration state to restart the upgrade.

## Roll out the first ownership-aware version

Use the existing Control API `Recreate` deployment strategy. Drain and stop every
previous password-verifier instance before routing to this version. An older binary
does not use this slot, so an overlapping rolling deployment cannot provide the new
guarantee. Apply the forward migration before starting the new instances. Do not
roll back to an older verifier while any ownership-aware verification can still run.

`Recreate` is not proof of termination on a disconnected node. If a node is unreachable,
do not rely on forced Pod deletion or an empty Kubernetes listing. Require verified
container/process termination from the node runtime, or infrastructure fencing that
prevents that node/process from resuming. If that evidence is unavailable, leave
password verification fail-closed and escalate to the infrastructure owner.

## Roll out the Spec 092 outcome-admission protocol

The migration runner keeps the database session advisory lock across the fence, owner drain
and schema upgrade, while committing the fence before waiting or migrating. In its first
durable transaction it marks admission as draining and installs database guards. Trigger DDL
waits for any legacy admission or completion transaction already holding those tables. Only
after the guards are installed does the transaction record `fenced_at_ms` and commit. This
timestamp therefore follows every legacy completion transaction that could still commit.

After the fence commits, an old verifier cannot start another owned bcrypt operation or write
identifier state. A verifier that released its work-owner row before its completion transaction
will have that late legacy write rejected; it must fail closed without issuing a session. The
migration then waits for the durable owner table to become empty without reclaiming it by age,
applies schema 0130 in a separate durable transaction, and verifies the rollout state is `v2`.
The migration backfill keeps a legacy hold for at least 15 minutes after the committed fence
timestamp. A migration timeout leaves the fence in place; retry the supported migration path or
keep password login unavailable. Do not manually clear the fence, owner, or identifier state.

The private dev workflow runs the migration before the rendered Control API release, and the
Deployment uses `Recreate` before new pods start. The database fence protects migration even
while old pods are still present; `Recreate` must still complete before new verifier processes
serve traffic. If node termination is uncertain, follow the exact-incarnation proof above and
do not treat an empty Kubernetes listing as proof.

## Recover an abandoned slot

This is a privileged, separately authorized operational change, not an API endpoint.

1. Stop password-verifier traffic and prevent new verifier instances from starting.
2. With an authorized database connection, inspect `singleton`, `operation_id`,
   `owner_instance`, `owner_host`, `owner_pid` and `acquired_at` in the work record.
   Keep this diagnostic identity in restricted operational evidence, not public logs.
3. Prove that **all** previous verifier instances can no longer execute, including
   suspended processes, old replicas and disconnected nodes. Host/PID alone is not
   sufficient: PIDs and hostnames are reusable. Record the instance/container identity
   and termination or fencing evidence. Neither session termination nor elapsed time
   meets this requirement.
4. Only after that proof, delete the exact observed record with predicates for both
   its `operation_id` and `owner_instance`, in a transaction with
   `SET LOCAL synchronous_commit = on`. Require exactly one returned row. A changed
   record or missing row means the observation is stale; stop and investigate.
5. Keep the aggregate pace and identifier state intact. Resume only ownership-aware
   instances and verify ordinary password authentication and current service health.

## Reconcile an abandoned identifier operation

Spec 092 adds a second durable fence: a running per-identity provisional operation. A
missing global work row does not prove this operation is safe to reuse. Do not delete
or expire a running identifier operation directly.

1. Complete the exact-incarnation termination/fencing proof above for every old verifier
   process. `password_work_process_incarnation` startup logs record the random process
   incarnation, host and PID without recording an identity or operation token. If those
   logs or infrastructure evidence cannot bind the persisted owner tuple to a terminated
   process, leave the identity fenced.
2. Using the authorized database owner, inspect the hashed identifier row and retain the
   exact `instance`, current `revision`, `provisional_operation`, `provisional_epoch`,
   `provisional_scope`, `provisional_quota_masked`, `provisional_owner_instance`,
   `provisional_owner_host` and `provisional_owner_pid`. Never include the unhashed email
   in an operational ticket or log.
3. If `terminal_operation` already equals the operation token, its receipt is authoritative.
   Do not debit or clear anything again. If the state instance, revision, token, phase, or
   owner tuple changes before reconciliation, stop; the observation is stale.
4. For an exact `running` operation, choose a disposition only from trusted evidence:
   - `failure`: authoritative evidence proves the verification completed unsuccessfully;
     add one F and start the 15-minute cooldown if this is the fifth completed failure.
   - `success`: authoritative evidence proves a public credential success; add one S only
     for a public, non-quota-masked operation. Authenticated reverification adds no S.
   - `prestart`: exact process evidence proves bcrypt never began; add no F, U or S.
   - `uncertain`: the default when bcrypt might have begun and no terminal outcome can be
     established; add one U and, for public non-masked work, one conservative S at database
     recovery time. A quota-masked dummy operation adds U but never S.

   A stale credential epoch is detected by the database routine and reconciles as `stale`
   without adding new-epoch F, U or S. Do not infer a successful or failed password from
   request status, elapsed time, a missing session, or a log that lacks an authoritative
   terminal receipt.

5. In one transaction with `SET LOCAL synchronous_commit = on`, call the restricted
   `public.password_reconcile_running_admission` database function with the exact values
   observed above and the chosen disposition. It locks and compare-and-sets that operation,
   applies bounded rolling-window accounting, writes the terminal receipt, and clears only
   that operation. A stale/mismatched tuple raises an error and changes nothing. The routine
   is revoked from `PUBLIC` and `control_api_runtime`; it is not an HTTP endpoint and cannot
   be used by application requests.

   Example invocation shape (replace every placeholder with the captured values; keep the
   disposition tied to the evidence review):

   ```sql
   BEGIN;
   SET LOCAL synchronous_commit = on;
   SELECT * FROM public.password_reconcile_running_admission(
     '<sha256 identifier key>'::text,
     '<state instance UUID>'::uuid,
     <current revision>::bigint,
     '<provisional operation UUID>'::uuid,
     <provisional epoch>::bigint,
     '<owner instance UUID>'::uuid,
     '<owner host>'::text,
     <owner PID>::integer,
     'uncertain'::text
   );
   COMMIT;
   ```

6. Confirm the returned disposition and receipt in the same transaction, then commit. A
   repeated call for an operation with the retained terminal receipt returns
   `already_terminal` and performs no second debit. If the receipt was overwritten or the
   state was recreated, stop rather than infer the outcome. Reconcile the global work row
   separately using its exact operation ID and owner instance as described above.
7. Resume only the ownership-aware verifier after checking the failure/cooldown, success and
   uncertainty arrays and the global owner state. Uncertainty can consume all five risk slots
   without being mislabeled as a wrong password; this fail-closed availability cost is
   approved.

No generic `TRUNCATE`, unconditional deletion, database-session kill, TTL reclaim or
automatic retry of bcrypt is a recovery mechanism. Database restoration/failover
must preserve acknowledged work reservations; recovering an older database snapshot
requires the same verifier termination/fencing procedure before reopening traffic.
