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

`keyper-labs/evenfire-infra#154` implements this order in the infra deploy
helper (it applies External REST and Profile UI first and waits for them before
control-api). Until it is merged on the infra repository's `main` and a dev
deploy log shows its `EDGE_PHASE apply` and `EDGE_PHASE settled` lines, run the
three steps by hand. With a single apply, old External REST pods meet the new
control-api, and team create, team switch and password reset fail (see
[The mixed window](#the-mixed-window)).

Before step 1:

- Check the database for state left by an earlier head of this change (see
  [Databases that ran an earlier head of this change](#databases-that-ran-an-earlier-head-of-this-change)).
- Check that `EXTERNAL_REST_API_CORS_ORIGIN` of `external-rest-api` lists the
  public Profile UI origin (scheme and host, no path):

  ```sh
  kubectl --context <context> -n profiles get deploy external-rest-api \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="external-rest-api")].env[?(@.name=="EXTERNAL_REST_API_CORS_ORIGIN")].value}'
  ```

  Profile UI reaches External REST through a same-origin rewrite, and External
  REST now refuses a browser mutation without a bearer token unless its
  `Origin` is in that list. If the Profile UI origin is missing, Profile UI
  login, logout, password reset, invitation accept and set-password answer
  `403 forbidden` "The browser request origin is not allowed." After step 2, a
  Profile UI password login must not answer that 403.

  Checked read-only on 2026-11-05: clerum-dev has
  `https://app.dev.evenfire.ai,https://profile.dev.evenfire.ai` and production
  (`clerum`) has `https://app.prod.evenfire.ai,https://profile.prod.evenfire.ai`;
  in both, cloudflared routes the Profile UI host to
  `profile-ui.profiles:3001`. The value lives in the infra repository, so check
  it again before each deploy.

- Ship the new Desktop build only after step 3.

For a database below `0130`, from the commit of `0130` in step 1 until the new
control-api is Ready in step 3, the old control-api cannot start new password
checks (the #1197 fence). Keep steps 2 and 3 short and use an off-peak window.
Google sign-in is not fenced.

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
- `GET /api/v1/me` for a session the old control-api considers ended answers
  `404 {"error":"User not found"}`, as on `dev`.

The opposite pairing, old External REST against the new control-api, is not
supported: team create, team switch and password reset fail in it. This is why
External REST and Profile UI roll out before control-api, and why a rollback
starts with control-api.

If the server does not confirm a sign-out (a 404 during the rollout window, a
503, or a network failure), Profile UI stops using the session cookie until the
next successful sign-in, a confirmed sign-out, or an accepted password reset,
and tells the user.

## Rollback residue

Session revocations and password epochs written by the new control-api are
ignored by the old one. The release installs no database triggers and no
revision functions, so nothing keeps running against the old image.

Logout revokes only the token it receives. A V1 token issued before a team
switch stays valid until its own expiry (at most 7 days, 604800 s), as on `dev`. A new
Desktop build against the old External REST removes a rejected stored token as
before this release.

## Migration preconditions and size

- The target database has no migration version and no object from an earlier
  head of this change; the migration Job stops otherwise (see
  [Databases that ran an earlier head of this change](#databases-that-ran-an-earlier-head-of-this-change)).
  The release adds `0131_user_access_foundation` and
  `0132_legacy_password_security_epoch_backfill`.
- PostgreSQL 14 or later. The migration session sets
  `client_connection_check_interval`, so that a killed Job pod does not leave
  its backend holding the migration advisory lock.
- For a database already at `0130`, every statement of `0131` and `0132`
  waits at most 10 s for a lock (`lock_timeout`), and ordinary statements are
  bounded at 15 s (`statement_timeout`); the online index builds have their own
  120 s bound (below). The whole Job is bounded at 300 s
  (`activeDeadlineSeconds`).
- An existing database below `0130` must already have `0126` to `0128`; the
  Job stops with an error otherwise. For such a database the 10 s lock bound
  does not hold before `0131`. The Job first sets the `0130` password-login
  fence, which waits up to 60 s for a lock and allows 60 s per statement
  (`dev` capped the statement at the pool's 15 s). It
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
- `CREATE INDEX CONCURRENTLY` waits for every transaction older than itself. A
  long transaction anywhere in the database (for example `pg_dump`) can hold
  every build until its 120 s bound and make the Job fail on every attempt. Do
  not run the migration during backups or other long transactions.
- The foreign keys to `users` take `SHARE ROW EXCLUSIVE` on `users` until
  `0131`'s transaction commits. Writes to `users` are blocked for that time.
  The wait for that lock is bounded at 10 s.
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
  and a V1 session lasts 7 days (604800 s). So a user whose password was set or
  changed within 7 days before the migration loses the sessions issued up to
  that second and must sign in again. If the release serving before the
  migration predates the seven-day V1 lifetime, its sessions last 12 hours and
  only password changes in the 12 hours before the migration are affected. This includes the session issued in the same second
  when a first password was set from an invitation, and the session from which
  a user changed their password in Profile UI. No other session is affected by
  the backfill.
- After the Job, `verify_db_migration_state` checks the grants of
  `workflow_recipes_runtime` against
  `deploy/scripts/workflow-recipes-runtime-access-profiles.tsv` (104 relation
  rows; `dev` had 7) and
  `deploy/scripts/workflow-recipes-runtime-column-access-profiles.tsv` (6
  column rows; new in this release). A mismatch stops the deploy after `0131`
  and `0132` have committed, while the old control-api keeps serving. Compare
  the target database's grants with both files before step 1.
- `deploy/scripts/run-control-api-db-migration.sh` requires `--timeout` (or
  `TIMEOUT`) to be a number with a unit (`s`, `m` or `h`) and at least `360s`;
  it only sets how long the script waits. The Job deadline is fixed at 300 s by
  `control-api-migration-execution-policy.json`, which must sit next to the
  script.
- A terminal migration Job left by an earlier run is deleted with a UID
  precondition taken from the Job the script just read. If another caller
  replaced that Job in the meantime, the script stops instead of deleting it.

## Databases that ran an earlier head of this change

Earlier heads of this change recorded other migration versions (under several
four-digit prefixes, some below `0130`, and the same
`0131_user_access_foundation` version with a larger body)
and created revision tables, catalog tables and `authorization_*` trigger
functions. The current migration runner does not drop them. Their triggers
would keep running for writers that no longer take the matching locks, so the
migration Job stops before `0131` when it finds any of them. Its error names
the versions, functions and tables it found.

The shared clusters (`clerum-dev` and production) never ran an earlier head.
Branch profiles and local databases may have.

Check query (read-only; run it as the control-api schema owner, with that
schema first in `search_path`):

```sql
SELECT 'version' AS kind, version AS name
  FROM schema_migrations
 WHERE substring(version from '^\d{4}_(.+)$') = ANY (ARRAY[
         'user_access_foundation',
         'invitation_delivery_commands',
         'catalog_utf8_ordering',
         'composable_catalog_revisions',
         'gfs_catalog_revision_components',
         'legacy_password_security_epoch_backfill',
         'user_access_foundation_definer_temp_shadow_hardening',
         'authorization_revision_delete_compatibility'
       ])
   AND version <> ALL (ARRAY[
         '0131_user_access_foundation',
         '0132_legacy_password_security_epoch_backfill'
       ])
UNION ALL
SELECT 'function', fn.oid::regprocedure::text
  FROM pg_proc fn
  JOIN pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace
 WHERE fn_ns.nspname = current_schema()
   AND (fn.proname LIKE 'authorization\_bump\_%' ESCAPE '\'
     OR fn.proname LIKE 'authorization\_prelock\_%' ESCAPE '\'
     OR fn.proname = 'catalog_utf8_bytes')
UNION ALL
SELECT 'table', rel.relname::text
  FROM pg_class rel
  JOIN pg_namespace rel_ns ON rel_ns.oid = rel.relnamespace
 WHERE rel_ns.nspname = current_schema()
   AND rel.relname = ANY (ARRAY[
         'authorization_catalog_environment',
         'authorization_catalog_revision',
         'authorization_catalog_writer_components',
         'authorization_resource_revisions',
         'authorization_team_revisions',
         'authorization_user_revisions',
         'invitation_delivery_commands',
         'operational_catalog_source_state',
         'operational_relationships_staging',
         'operational_resource_index',
         'operational_resource_index_staging',
         'operational_resource_relationships'
       ])
 ORDER BY 1, 2;
```

No rows means the database is ready for step 1. If it returns rows:

- Branch profiles: delete and recreate the profile.
- Other databases: stop control-api, every migration Job and trace maintenance,
  then run `docs/deploy/sql/user-access-foundation-earlier-head-cleanup.sql`
  once, as the schema owner. It runs in one transaction. It drops the
  functions (with their triggers), the tables and the earlier-head indexes on
  existing tables, and deletes the earlier-head migration versions. It keeps
  `0131_user_access_foundation` and `0132_legacy_password_security_epoch_backfill`
  when they are present. Run the check query again (no rows), then run the
  migration Job.

## What to tell users and operators

- Team budgets no longer cover direct-grant V1 workflow runs. Those runs are
  still recorded and budgeted by user, recipe, Host and LLM secret.
- A Google user who has only a pending invitation gets a session without a team
  until they accept the invitation.
- Users who set or changed their password in the 7 days before the migration
  must sign in again (see the `0132` bullet above).

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
