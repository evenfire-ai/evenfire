# Recover password verification ownership

Member password login and Desktop password reverification use the persisted
`password_verification_work` singleton to bound actual bcrypt work across processes.
The slot has no expiry. Database connection loss, a missed heartbeat, capture expiry,
or a process restart does not prove that the old computation stopped.

A crashed owner or an ambiguous acquisition/release can therefore leave password
verification unavailable. Other authentication methods and credential recovery keep
their existing policies. Never clear this record from a request, cleanup job, startup
hook, or automated timeout. Do not reset the pace or identifier history to recover it.

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

No generic `TRUNCATE`, unconditional deletion, database-session kill, TTL reclaim or
automatic retry of bcrypt is a recovery mechanism. Database restoration/failover
must preserve acknowledged work reservations; recovering an older database snapshot
requires the same verifier termination/fencing procedure before reopening traffic.
