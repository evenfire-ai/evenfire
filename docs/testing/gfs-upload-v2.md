# GFS Upload v2 testing contract

This document is the executable test contract for the 200 MiB GFS Upload v2
rollout. It is intentionally separate from the legacy small-file GFS suites.
The feature flag remains false until T0, T1, T2, and T3 are green.

## Test fixtures

Generate deterministic files in a run-unique temporary directory, not in the
repository and not in memory:

| Fixture           |                          Exact size |
| ----------------- | ----------------------------------: |
| below boundary    |                   `209715199` bytes |
| exact boundary    |                   `209715200` bytes |
| oversize          |                   `209715201` bytes |
| legacy regression | `16777216` bytes and one byte above |

Record SHA-256 for every fixture and verify the downloaded result matches the
source. A fixture may be sparse only when the target filesystem and the
checksum step prove the bytes; the default fixture is deterministic, ordinary
file data. No test uses `Buffer`, `arrayBuffer()`, base64, browser storage, or
an API shortcut for a whole file.

## T0 — static and unit

T0 must execute real tests and fail loudly if zero tests run. It covers:

- exact binary boundary and oversize rejection before session allocation;
- strict part geometry, min/max part sizes, zero-byte geometry, gap/overlap
  rejection, checksums, indexed idempotent replay and fingerprint conflicts;
- owner isolation, current authorization, leases, expiry, pause/resume,
  terminal cancel, finalization fencing, storage admission and bounded quotas;
- route recognition and writer selection for capabilities, `HEAD`, status,
  part PUT, pause/resume, complete, and DELETE;
- no v2 whole-file `Buffer`/`ArrayBuffer`/base64/JSON/IPC value;
- retry classification, response-loss reconciliation, contiguous-vs-committed
  progress, four-to-two fallback, and Desktop IPC byte isolation;
- proxy invariants: exact v2 prefix bypasses the broad JSON parser, declared
  and observed 16 MiB caps are enforced, `Expect` is stripped, upload headers
  survive, and disconnect aborts upstream.
- canonical-drive propagation for a non-`main` drive through capabilities,
  create, HEAD, status, part, pause, resume, complete, and cancel; missing or
  create-body-mismatched drive is rejected before GFSC token minting;
- replica-safe request limits, weighted 1 MiB byte charging, stable 429 plus
  `Retry-After`, active principal/IP/global concurrency release, and fail-closed
  admission-backend failure;
- Desktop state-v2 migration and legacy quarantine, exact owner/team/env/base/
  drive resume matching, A → logout → B isolation, epoch-stale dispatch
  rejection, and `suspended_auth` requiring explicit same-scope resume;
- legacy fallback symlink/path-swap rejection and proof that logout aborts and
  awaits a pending fallback before clearing the captured credential.

The T0 red fixtures are contract tests: before the implementation seam exists,
they must be marked as planned/disabled in the test harness rather than hidden
behind a passing assertion. Once PR1/PR2 land, each fixture is enabled and a
zero-executed-test result is a failure.

## T1 — integration and real Postgres

T1 uses real Postgres for migration and role checks. It proves:

- additive migration order, exact writer-only session-table privileges, and
  complete denial for `control_api_runtime`, the reader role, and `PUBLIC`;
- session/part uniqueness, offset geometry, idempotency, status map and
  response-loss replay;
- restart recovery, orphan reconciliation, lease release, disk reservation,
  bounded per-subject/global concurrency and finalization limits;
- external-rest-api → profile funnel → control-api → GFSC streaming with
  backpressure, auth re-check, header/status preservation and no broad-parser
  buffering;
- atomic resource/manifest/audit/session completion with no duplicate on crash
  or replay, create-name race, replace `ifMatch` conflict, or checksum error;
- cancel-versus-part-commit and cancel-versus-finalize hold-before-commit
  races. The latter must deterministically return `409 upload_finalizing` and
  yield either one committed publication or a cleaned failure, never a
  canceled response with a published resource;
- same name/size/mtime with different bytes cannot adopt a committed part or
  complete a resumed session.

The 512 MiB/1 GiB arithmetic ceiling is tested only under an explicit protocol
test configuration. It must not become an enabled 200 MiB product capability.

## Control UI and Desktop E2E Guardian gate

New large-upload projects must enter through real visible user actions (file
picker or drag/drop from the product surface), observe a visible intermediate
progress state at least twice before completion, and verify the final visible
state plus a business signal: resource identity/version and SHA-256. The tests
must use stable accessible labels or `data-testid` selectors, wait on critical
responses/state transitions, retain traces on failure, and clean up by
run-unique owner/session identifiers.

Required journeys:

1. create and replace at `209715199` and `209715200` bytes;
2. connection drop/timeout, writer restart, response loss, resume after app
   restart, and exact committed-part adoption;
3. visible pause then resume, and separate terminal cancel with no resource;
4. retryable failures that show four parts in flight before the threshold and
   no more than two afterward, with one correct progress bar;
5. oversize `209715201` rejection before any session/part/complete request;
6. permission revocation while paused, with visible denial and no publication;
7. v2-disabled legacy fallback at 16 MiB and rejection above the legacy cap;
8. foreign/missing session and direct terminal/deep-link guards never show
   `Completed` without the server receipt.

The E2E Guardian adversarial gate must fail if an intermediate page disappears,
submit does nothing, the API succeeds but the UI does not transition, or a
direct terminal URL makes the happy path look complete. Do not use fixed
sleeps, direct terminal navigation in a happy path, storage/session mutation,
global core-route mocks, or `{ force: true }` to bypass the product journey.

## T2 — owned Minikube and Cloudflare-backed dev host

Before cluster work record worktree, branch, exact HEAD, `origin/dev`, profile,
explicit Kubernetes context, pre-gate marker, random profile-owned ports, and
active processes. Every `kubectl` invocation carries that context. Use four
subjects or a documented test-only quota override for concurrent maximum-size
uploads. Prove no OOMKill/restart/corruption, peak RSS below 80% of limits,
bounded finalization, expected disk growth, unrelated small-request latency
within baseline, and no more than four per-session/sixteen global part streams
unless capability negotiation advertises lower.

The browser and packaged Desktop journeys run through the Cloudflare-backed
dev hostname. A local green suite is not T2 evidence.

## T3 — packaged Desktop

Use the packaged Electron artifact, not only renderer tests. Select and
drag/drop exact-boundary arbitrary binary files (including `.parquet`), verify
responsive progress, pause/resume, terminal cancel, persisted resume after
restart, source-file mutation failure, no giant IPC message, bounded large
download-to-disk, and legacy fallback against a v2-disabled server.

## Static E2E audit and evidence

Before accepting new E2E files add `tools/e2e_static_audit.py` and run it on
changed specs. It rejects fixed sleeps, storage/session mutation, core-route
success mocks, fragile selectors, direct terminal happy paths, and missing
critical-response waits. Configure large-upload projects with
`trace: 'retain-on-failure'`; retries may not hide a failed journey.

Every gate records command, exact commit SHA, fixture size/hash, route and
hostname, pass/fail, executed/skipped counts, peak RSS, restarts, PVC free
space, and unresolved blockers. T0/T1 evidence must pass before commit/push/PR;
the exact-head `review-pr` audit must pass before T2. The review is read-only
and cannot be replaced by a green unit suite or a documentation screenshot.
