# Manually verify password recovery with the development producer

Use this guide in a **separate, authorized manual session** after fetching PR #1056.
Audience: a developer or platform owner with access to the intended development
Member Registration producer, its test data and an approved recipient mailbox.
This guide describes the configured integration lane and a separate email/UI
journey. Neither lane was executed while implementing the structural redesign.
Both remain **NOT VERIFIED** until their own receipts are recorded.

## A. Obtain and build the published revision

From the intended main Evenfire checkout, inspect before changing anything:

```sh
pwd
git remote get-url origin
git branch --show-current
git status --short
git rev-parse HEAD
git fetch origin fix/issue-1055-password-admission-dos
```

Confirm the remote is `evenfire-ai/evenfire`. Preserve unrelated local work;
if switching would overwrite it, stop and use another clean checkout or agree on
its disposition. Do not hard reset, force checkout, or automatically stash it.
In a clean checkout already on the PR branch, use:

```sh
git merge --ff-only origin/fix/issue-1055-password-admission-dos
git rev-parse HEAD
```

If the branch is not checked out and no conflicting local work exists, switch
to the existing local branch with `git switch fix/issue-1055-password-admission-dos`
(or create its tracking branch with `git switch --track origin/fix/issue-1055-password-admission-dos`).
Then fast-forward as above. Divergence needs a decision; this guide does not
authorize rebasing or rewriting history. Compare the actual SHA with GitHub's
current PR head and record it in the receipt.

Use Node 24 and the checked-in lockfiles:

```sh
node --version
npm --prefix packages/workflow-runtime-core ci
npm --prefix packages/workflow-runtime-core run build
npm --prefix control-api ci
npm --prefix external-rest-api ci
npm --prefix control-api run build
npm --prefix external-rest-api run build
node scripts/ci/password-recovery-suite-contract.mjs verify
```

The composed local private suite needs the built External REST app. Each service
owns its dependencies; another CI job's artifacts do not satisfy this prerequisite.
For the optional later UI journey, install/build Profile UI according to its
live local guidance. Do not treat a local UI attached to older backend images as
verification of this revision; record the backend revisions separately.

## B. Establish the real development producer

Obtain the actual development cluster, zone, project, account, Kubernetes user and
context from the owner's approved private infrastructure record. Keep concrete
infrastructure identifiers out of this public repository and sanitized receipts.
The existing setup sequence is shown with verified-input variables below. It is
reference context for a later authorized session, not proof that Member
Registration is deployed in that cluster:

```sh
gcloud container clusters get-credentials "${VERIFIED_DEV_CLUSTER:?Confirm the development cluster}" \
  --zone="${VERIFIED_DEV_ZONE:?Confirm the development zone}" --project="${VERIFIED_DEV_PROJECT:?Confirm the development project}" \
  --account="${AUTHORIZED_DEV_ACCOUNT:?Confirm the authorized account}"
kubectl config set-credentials "${VERIFIED_DEV_KUBE_USER:?Confirm the Kubernetes user}" \
  --exec-arg="--account=${AUTHORIZED_DEV_ACCOUNT:?Confirm the authorized account}"
LOCAL_KUBE_CONTEXT="${VERIFIED_DEV_CONTEXT:?Confirm the development context}" npm run ui
```

Confirm that the Kubernetes user entry belongs to the intended context before
changing its account binding. Required expansions fail before a command runs when
a verified input is missing; no command falls back to the current context. Populate
these variables locally from the approved
record; do not invent values, commit them or paste them into a PR receipt.

Earlier read-only discovery found no `registration` namespace in the owner-selected development context.
The Control API configuration referenced the external registration hub at
`registration.evenfire.ai`; its deployment ownership, version, database and
isolation were not established. Reconfirm these facts. Do not select the first
similarly named service or infer the producer from the UI launch command.

After access is authorized, use explicit-context read-only discovery:

```sh
kubectl --context="${VERIFIED_DEV_CONTEXT:?Confirm the development context}" get namespaces
kubectl --context="${VERIFIED_DEV_CONTEXT:?Confirm the development context}" get services --all-namespaces
kubectl --context="${VERIFIED_DEV_CONTEXT:?Confirm the development context}" get deployments --all-namespaces \
  -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,IMAGES:.spec.template.spec.containers[*].image
```

Confirm the actual namespace/service/deployment with its owner. Read only the
specific non-secret endpoint field from the confirmed configuration object;
do not dump Secrets, environment files or whole configuration objects.
For a confirmed Deployment, inspect its image and the running Pod image ID
with context-qualified commands and compare the immutable image provenance
with the producer's source revision. Record the actual deployed revision.
Ask the owner to identify the producer database, tenant/key binding, recipient
policy and whether the target is isolated or approved for this synthetic write.
An image tag, HTTP health response or UI screenshot alone does not establish
version, database identity or permission to send email.

If the producer is outside this cluster, discover it through its actual hosting
owner. The GKE UI workflow does not create a supported port-forward to it.
If a confirmed in-cluster producer needs a forward, obtain its exact Service
port and namespace first. Use a task-owned loopback forward in a dedicated
terminal, without inventing names or ports:

```sh
kubectl --context="${VERIFIED_DEV_CONTEXT:?Confirm the development context}" -n "$VERIFIED_NAMESPACE" port-forward \
  --address=127.0.0.1 "service/$VERIFIED_SERVICE" ":$VERIFIED_SERVICE_PORT"
```

Use the allocated local port shown by that process only for this session, and
stop the forward afterward. Confirm any network/proxy requirements with the
owner; do not port-forward or mutate a shared environment without authorization.

## C. Provide configuration securely

Use an approved credential store or secure interactive entry into process
memory. In a local Bash shell, disable tracing and prompt without echo:

```bash
set +x
read -r -s -p 'Isolated Control API PostgreSQL admin DSN: ' CONTROL_API_REAL_PG_ADMIN_URL; printf '\n'
read -r -s -p 'Authorized producer PostgreSQL DSN: ' CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL; printf '\n'
read -r -s -p 'Verified producer API base URL: ' CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL; printf '\n'
read -r -s -p 'Authorized producer HMAC secret (hidden)> ' CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET; printf '\n'
export CONTROL_API_REAL_PG_ADMIN_URL CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL
export CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
```

The first DSN must target an authorized disposable PostgreSQL 16 instance with
CREATE/DROP DATABASE permission. The second must identify the producer's
explicitly authorized test database. They have different effects. Do not point
the admin DSN at production or an unrelated shared database.

The runner requires these four variables. Successful authentication also
requires the matching producer tenant and HMAC key ID; confirm whether
`CONTROL_API_MEMBER_REGISTRATION_TENANT_ID` and
`CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` need explicit values. Verify that
`CONTROL_API_MEMBER_REGISTRATION_MODE=remote` matches the intended producer
configuration. Do not accept test defaults as evidence of the deployed binding.
Confirm the configured redirect/app metadata against the producer's allowed
URLs; the standalone configured suite is not a deployment compatibility test.

Never echo these variables, persist them in a receipt, paste literal values into
shell commands, or enable `set -x`. Do not print `.env` contents or URLs containing
credentials. Test runners may report operational errors: inspect locally,
sanitize before sharing and do not publish raw producer/database logs.
Unset all supplied secrets after the session, including optional credential
inputs, and stop any task-owned port-forward or test process.

## D. Authorize the actual data and email effects

Before running, record owner approval for these concrete effects:

- A random `bug192_flow_*` Control API database is created, migrated and filled
  with synthetic users, invitations and admission state; teardown drops it.
  DELETE statements in setup operate inside that temporary database.
- The producer receives real authenticated registration/validation requests and
  stores a synthetic `invitation_flow_registrations` row for a random
  `issue1055-*` address under `example.invalid`.
- Producer `ensureApp`/`ensureLatestAppConfig` may create `apps`/`app_configs`
  rows. Existing teardown deletes flow rows by the generated test email but
  does **not** remove these possible app/config records.
- Registration also inserts `invite_send_log` and `invite_redirect_tokens`
  before sending email. Both records can persist when SMTP fails; configured
  teardown does not delete them. For an external tenant binding, send-log
  entries count toward the destination domain's daily quota. Confirm the
  actual deployed revision, tenant binding and applicable quota before running.
- A redirect record's `destination_url` contains signed invitation proof.
  The inspected producer assigns a 30-day redirect expiry; expiry does not
  physically delete the record. Confirm retention and narrowly scoped cleanup
  with the owner. Never include the redirect token or destination URL in a receipt.
- Registration calls the real invitation email path. Checked-in producer
  deployment configuration uses Postmark SMTP. A non-delivering configuration
  has not been established; outbound email may be attempted, and an invalid
  recipient can cause rejection/bounce rather than delivery.

The configured suite's generated address is not a configurable permitted
mailbox. Confirm that this exact synthetic recipient/write scope is approved
and compatible with the development email service before execution. Use a
separate permitted mailbox for the delivery/UI journey below. Do not silently
change the runner to skip email, change recipients or omit cleanup.

Clearly identifiable synthetic development records may remain when explicitly
accepted by the owner. Obtain separate approval for retained app/config records,
send-log entries, proof-bearing redirect records and any applicable quota effects;
willingness to retain app/config rows alone does not authorize the other effects.
Record sanitized counts or non-secret identifiers and their retention or cleanup
disposition. Do not assume that deleting a flow row cascades to redirect/send-log
records, or that expiration proves deletion. This acceptance does not disable the
runner's existing flow-row DELETE or temporary-database DROP. If teardown fails,
confirm the exact generated resources before any manual deletion; never broadly
delete producer data.

## E. Run the configured integration lane

The final checked-in command and physical suite remain:

```sh
bash scripts/ci/run-password-recovery-private-postgres.sh configured
```

It selects exactly
`control-api/test/passwordRecovery.memberRegistration.realPostgres.integration.test.ts`
through the strict suite manifest. Expect one physical suite and one passing
scenario, containing admission-denial, real stored signed proof, preview/row
binding, wrong-email/row negatives, reset session and later-login assertions.
Require process exit zero, nonzero passing collection and **zero skipped tests**.
The runner rejects missing files/environment and skipped/zero-test results.
The configured suite does not start or replace the producer, and does not prove
public External REST cookies or actual mailbox delivery.

If collection skips, configuration is missing, authentication fails or the
producer/database cannot be identified, record **NOT VERIFIED**. For a test
failure, record its phase and sanitized error category: configuration/tenant,
producer registration, persisted proof, validation, Control API mutation/session,
or teardown. Do not substitute mocked receipts. Record the exact source SHA,
producer revision, permitted data effects and cleanup result.

`local` is a separate real-producer lane requiring the Member Registration source
checkout, installed `tsx`, two disposable databases and the built HTTP child;
see [private runner reference](password-recovery-private-postgres.md). It is not
configured-producer or email-delivery evidence. Do not run `all` merely to obtain
a green status without both lanes' explicit authorization.

## F. Verify actual email delivery and the public UI journey

Use the confirmed development invitation email service and a dedicated synthetic
account with an owner-approved mailbox. Do not add a test mail system for this
journey. Establish the intended Profile UI and External REST origins and backend
revisions, and ensure no unrelated account uses the synthetic address.

1. Request recovery through the intended Profile UI, which calls public
   `POST /api/v1/auth/password-reset/request`. Check its non-enumerating success
   without assuming that response proves delivery. Observe the actual message
   arriving in the permitted mailbox; record a redacted timestamp/message receipt.
2. Inspect the destination origin/path privately before opening the link. The
   producer proof must bind to the intended invitation token/email/row; the row
   ID and invitation token are distinct. Do not publish the URL or proof.
3. Use a valid fresh link and confirm the reset view shows the intended account.
   Separately exercise invalid proof and mismatched email/row input using only
   synthetic records: they must not update credentials, create a cookie or expose
   another account. Avoid modifying or probing an unrelated invitation.
4. Submit an approved valid replacement password once. Confirm the correct
   account identity and authenticated session. Inspect cookie **attributes**
   privately: `profile_session`, HttpOnly, expected Path/SameSite and Secure for
   the intended HTTPS environment. Do not record cookie or token values.
5. Confirm session hydration and navigation to the authenticated view, including
   a refresh. The UI must not automatically replay the reset after a hydration
   failure. Record the displayed account identity in sanitized form.
6. Reuse the consumed proof once deliberately: completion must be rejected,
   credentials must stay unchanged and no new authenticated session may be
   published from that replay. Confirm sibling reset invalidation using only
   owner-approved synthetic links where applicable.
7. Where normal admission permits, log in with the new password and verify the
   same account. Inspect only the authorized synthetic account/invitation state
   to confirm unrelated records were unaffected.

Do not deliberately saturate shared dev login capacity, consume another user's
budget or inject wire/database/email failures into shared services. Busy-owner,
unknown COMMIT, FATAL/lost acknowledgement, storage outage and connection cleanup
faults belong in a separately authorized isolated environment. A normal admission
429 must remain bounded and must not trigger automatic reset replay.

Configured SQL/producer integration and this delivery/UI journey are separate
evidence lanes. Passing either does not certify the other, and source/local
synthetic-browser results do not certify deployed versions.

## G. Record and share a sanitized receipt

Copy this checklist into the authorized review record:

```text
Date / tester:
PR SHA fetched and tested:
Control API / External REST / Profile revisions actually running:
Member Registration immutable image / source revision:
Verified dev context and confirmed producer owner/service:
Authorized test database identity (no DSN):
Authorization for synthetic SQL, producer effects and email:
Configured command / exit code:
Physical suites / passed / failed / skipped counts:
Manual email receipt and timestamp (redacted):
Link origin and trusted account/token binding (no URL/proof):
Reset / invalid / mismatch / consumed-proof results:
Cookie attributes / session identity / hydration / navigation:
New-password login under ordinary admission:
Unrelated synthetic account/invitation state:
Flow-row cleanup / temporary database drop:
Remaining synthetic app/config records and owner disposition:
Send-log records / applicable quota effects / owner disposition:
Redirect records / expiry / retention or exact cleanup (no token or destination URL):
Stopped task-owned processes / forwards / unset credentials:
Unverified or failed paths:
Reviewer / owner merge-sign-off decision:
```

A later authorized PR update should state the exact tested SHA and producer
revision, separate the two evidence lanes, include counts and sanitized outcomes,
and retain any unresolved limitation. Never attach credentials, full logs,
mailbox content, link tokens, database URLs or session cookies. Missing or skipped
integration remains **NOT VERIFIED**; it is not a merge certification.
