# PR #1056 private password-recovery integration lane

Public CI excludes the two cross-service recovery suites because they require the
real Member Registration producer and isolated PostgreSQL databases. The public
PostgreSQL job checks that both pinned suite files exist before excluding them;
that check proves suite discoverability, not producer execution.

For later configured dev discovery, secure configuration, actual data/email effects and a
separate mailbox/UI journey, use the [manual development guide](password-recovery-dev-integration.md).
Neither private mode nor real email delivery was run during the structural redesign.

Build the relevant locked service dependencies first:

```sh
npm --prefix packages/workflow-runtime-core ci
npm --prefix packages/workflow-runtime-core run build
npm --prefix control-api ci
npm --prefix external-rest-api ci
npm --prefix control-api run build
npm --prefix external-rest-api run build
node scripts/ci/password-recovery-suite-contract.mjs verify
```

Run the producer-backed lane from the Evenfire repository root:

```sh
bash scripts/ci/run-password-recovery-private-postgres.sh local
bash scripts/ci/run-password-recovery-private-postgres.sh configured
bash scripts/ci/run-password-recovery-private-postgres.sh all
```

`local` runs `control-api/test/passwordResetPayload.externalRest.realPostgres.integration.test.ts`.
It requires an isolated PostgreSQL 16 admin DSN in `CONTROL_API_REAL_PG_ADMIN_URL`,
the Member Registration source checkout in `EVENFIRE_MEMBER_REGISTRATION_ROOT`,
that checkout's installed `tsx` dependencies, and `external-rest-api/dist/app.js`.
The local public consumer runs as a bounded built HTTP child. The suite creates temporary
control and producer databases and launches the real local Member Registration
service. Use a disposable local PostgreSQL instance only.

`configured` runs `control-api/test/passwordRecovery.memberRegistration.realPostgres.integration.test.ts`.
It requires `CONTROL_API_REAL_PG_ADMIN_URL`,
`CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL`,
`CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL`, and
`CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET`. The service URL and HMAC must refer
to a real authorized Member Registration producer and its real PostgreSQL data.
The test creates a temporary Control API database and observes the configured
producer database; it does not start or replace that producer. Teardown deletes the
generated email's flow rows and drops the temporary Control API database, but does
not remove possible producer `apps`/`app_configs` rows. Registration may invoke
Postmark SMTP; authorize the generated synthetic recipient and actual email scope
before running. This suite does not verify mailbox delivery.

`all` runs both modes sequentially and requires both sets of prerequisites. The
runner verifies each exact suite file, requires at least one passing test, and
fails if Vitest reports skipped tests. It does not print environment values.
Do not substitute mocked producer responses for either suite. If a mode's
producer, database, credentials, or service dependencies are unavailable, report
that mode as **NOT VERIFIED** rather than treating the public CI exclusion check
as execution evidence.
