# User Access Foundation Upgrade Note

This release adds server-side External REST user sessions to control-api: a
session record per sign-in, a password security epoch per user, and
revocations for V1 session tokens. Two control-api migrations create and fill
them. External REST and Profile UI change with it, so the rollout order below
matters.

## Rollout order

The order is owned by `keyper-labs/evenfire-infra#143`. For this release it
replaces step 3 of the [general order](releases-and-upgrades.md#general-order)
(all images at once):

1. Run the control-api migration gate (the migration Job) and wait for it to
   finish.
2. Roll out External REST and Profile UI. Wait for `kubectl rollout status` on
   both, and check that no pod of an older ReplicaSet is left.
3. Roll out control-api and every other workload.

Rollback goes the other way: control-api first, then External REST and Profile
UI.

## The mixed window

Between steps 2 and 3, and during a rollback, the new External REST runs against
the old control-api. `external-rest-api/test/mixedVersion.baseControlApi.test.ts`
pins this pairing:

- Switch team and create team work. The old control-api ignores the session
  header.
- A password reset succeeds and asks the user to sign in again.
- A replayed invitation accept behaves as before this release: External REST
  sets the session cookie from the token the old control-api returns.
- A Profile UI sign-out gets the old control-api's `404 {"error":"Not Found"}`.
  External REST forwards it and clears the cookie, and Profile UI reports that
  the revocation was not confirmed.
- Native bearer tokens stay valid until their TTL, as before this release.

If the server does not confirm a sign-out (a 404 during the rollout window, a
503, or a network failure), Profile UI stops using the session cookie until the
next successful sign-in, a confirmed sign-out, or an accepted password reset,
and tells the user.

## Rollback residue

Session revocations and password epochs written by the new control-api are
ignored by the old one. The release installs no database triggers and no
revision functions, so nothing keeps running against the old image.

## Migration preconditions and size

- The target database has no `schema_migrations` row with a version from
  `0131` to `0135`. The release adds `0131_user_access_foundation` and
  `0132_legacy_password_security_epoch_backfill`.
- For a database already at `0130`, every statement of `0131` and `0132`
  waits at most 10 s for a lock (`lock_timeout`), and ordinary statements are
  bounded at 15 s (`statement_timeout`); the online index builds have their own
  120 s bound (below). The whole Job is bounded at 300 s
  (`activeDeadlineSeconds`).
- An existing database below `0130` must already have `0126` to `0128`; the
  Job stops with an error otherwise. For such a database the 10 s lock bound
  does not hold before `0131`. The Job first sets the `0130` password-login
  fence, which waits up to 60 s for a lock and allows 60 s per statement. It
  then waits, with no limit of its own, until password checks already in
  progress finish. It then applies `0129` (when missing) and `0130` in one
  transaction. `0129` raises `lock_timeout` to 60 s and then sets it to 0 (no
  limit) for the rest of that transaction, so a lock wait there is bounded only
  by the 15 s statement timeout. In that case the only bound on the whole
  catch-up is the Job's 300 s deadline; plan the maintenance window for it.
- `0131_user_access_foundation` first builds five indexes online
  (`CREATE INDEX CONCURRENTLY`, which takes `ShareUpdateExclusiveLock`) on
  the existing tables `team_members`, `user_contexts`, `team_contexts`,
  `user_agents` and `team_agents`. Each build scans its table, and each runs
  under a 120 s `statement_timeout` of its own, inside the Job's 300 s. They
  took 0.1–0.3 s each at measured sizes. It then creates the three session
  tables, with foreign keys to `users`, and their four indexes inside its
  bounded transaction.
- `0132_legacy_password_security_epoch_backfill` copies `password_set_at` of
  every user that has one into the password epochs, in one `INSERT … SELECT`
  over `users`. It takes `AccessShareLock` on `users`, which does not block
  ordinary reads and writes but does conflict with operations that need
  `AccessExclusiveLock`, such as `TRUNCATE`, `DROP TABLE` or most
  `ALTER TABLE` forms. It must finish within the 15 s statement timeout.
  Measured at about 6 µs per row on one laptop, it reaches that timeout near
  2.4 million users and then fails without a partial write.
- `0132` treats every V1 session issued at or before the second of a user's
  `password_set_at` as issued before that password event, and rejects it. The
  previous release kept existing sessions when a password was set or changed,
  and a V1 session lasts 12 hours. So a user whose password was set or changed
  within 12 hours before the migration loses the sessions issued up to that
  second and must sign in again. This includes the session issued in the same second
  when a first password was set from an invitation, and the session from which
  a user changed their password in Profile UI. No other session is affected by
  the backfill.

## Variables this release does not read

Pre-release builds of this change read the following control-api variables. The
release does not, so setting them has no effect. Remove them from any
environment that set them for those builds:

- `CONTROL_API_OPERATIONAL_ACCESS_INDEXER_ENABLED`,
  `CONTROL_API_OPERATIONAL_ACCESS_INDEXER_RETRY_MS`,
  `CONTROL_API_OPERATIONAL_ACCESS_READINESS_MAX_AGE_MS`;
- `CONTROL_API_USER_ACCESS_CATALOG_ACTIVATION_RECORD`,
  `CONTROL_API_USER_ACCESS_CATALOG_MODE`,
  `CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT`;
- `CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2`,
  `CONTROL_API_USER_ACCESS_RPC_DELEGATION_V2`,
  `CONTROL_API_USER_ACCESS_DESKTOP_ALL_TEAM_MODE`,
  `CONTROL_API_USER_ACCESS_PROFILE_V2_MODE`.
