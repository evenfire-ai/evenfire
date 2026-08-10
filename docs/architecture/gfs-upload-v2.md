# GFS Upload v2 architecture

Status: contract for the additive 200 MiB rollout. v2 remains disabled until
the T0–T3 gates in [the testing contract](../testing/gfs-upload-v2.md) pass.

## Decision

The packaged Desktop app and Control UI use a custom indexed resumable upload
protocol. A small metadata request creates a server-owned session; each binary
part is sent in its own authenticated request; the GFS writer stages parts on
the existing PVC and streams them in order into the immutable blob writer at
finalization.

This is deliberately not a one-request 200 MiB upload and is not a claim of
tus 1.0 compatibility. It does not raise the legacy JSON/base64 body limit.

| Contract | Frozen value |
| --- | ---: |
| Product maximum | `209715200` bytes (200 MiB binary) |
| Oversize boundary | `209715201` is rejected before session/payload allocation |
| Preferred part | `8388608` bytes (8 MiB) |
| Hard part/request maximum | `16777216` bytes (16 MiB) |
| Default session concurrency | 4 parts |
| Instability fallback | 2 parts after 3 consecutive retryable failures/timeouts |
| Legacy raw-file limit | `16777216` bytes (16 MiB), unchanged during rollout |
| Legacy GFSC body cap | `25165824` bytes (24 MiB), unchanged during rollout |
| Protocol arithmetic ceiling | `1073741824` bytes (1 GiB); not an enabled product value |

Cloudflare evaluates the body of each HTTP request. The aggregate file limit
is therefore independent of the request limit: every v2 data-bearing request
is at most 16 MiB, and the verified zone setting can force a lower negotiated
`maxChunkBytes`. No client may send a single 100 MB or 200 MiB body.

## End-to-end shape

```text
Control UI / Desktop
  -> authenticated capabilities + small JSON session create
  -> indexed binary PUT parts (4 in flight, then 2 on instability)
  -> UI/HTTP relays with backpressure and no whole-file buffering
  -> gfsc writer
  -> staged part files on <GFS root>/.uploads/<server-upload-uuid>/parts
  -> ordered stream into immutable blob writer
  -> resource + manifest + audit + completed receipt transaction
```

The browser renderer never receives a GFSC bearer token. Desktop main reads
one bounded part per request; file paths and metadata cross the preload bridge,
not a whole-file IPC value. Legacy agent/host JSON callers remain separate.

## Protocol surface

The public relays expose the same contract to the authenticated user:

- `GET /v1/capabilities` (`Cache-Control: no-store`);
- `POST /v1/uploads` with at most 64 KiB JSON metadata;
- `HEAD /v1/uploads/:uploadId` for the contiguous prefix;
- `GET /v1/uploads/:uploadId/status` for a bounded committed-part map,
  including part number, offset, length, and SHA-256;
- `PUT /v1/uploads/:uploadId/parts/:partNumber` with raw
  `application/offset+octet-stream` bytes;
- `POST /v1/uploads/:uploadId/pause` and `/resume`;
- `POST /v1/uploads/:uploadId/complete` with an empty or at most 16 KiB body;
- `DELETE /v1/uploads/:uploadId` as terminal cancel.

The writer selects one deterministic `partBytes` for a session. Part number,
offset, and length are derived from that geometry; parallel PUTs are
independently idempotent. A committed repeat with the same length and checksum
is successful without rewriting; a conflicting repeat is a stable conflict.
The database has unique `(upload_id, part_number)` and `(upload_id,
offset_bytes)` keys, so a scalar append offset can never masquerade as a
parallel protocol.

### Session state

`initiated → uploading ↔ paused → finalizing → completed` is the successful
path. `aborted`, `expired`, and `failed` are terminal. Pause drains reserved
parts before becoming `paused`; cancel advances `session_epoch`, aborts in-flight
streams, releases the reservation, and removes staging. Cancel is not resume.

`complete` first locks the session row and changes it to `finalizing`. DELETE
observing that state returns `409 upload_finalizing`; it does not report a
false cancellation. The publication transaction re-checks state and epoch
before writing the resource, so a canceled response can never accompany a
published resource.

## Persistence and safety

`gfs_upload_sessions` stores owner, operation/target, an immutable request
fingerprint, expected bytes, selected geometry, checksum, counters, state,
epochs, expiry, and the completion receipt. `gfs_upload_parts` stores only
part metadata, checksum, lease state, and a server-generated staging path; it
never stores the chunk bytes in Postgres. The writer role alone may mutate both
tables. Readers cannot mutate sessions, and even `HEAD` is routed to the
writer.

Before accepting a part the writer re-authorizes the current principal,
reserves the indexed part and a global/session stream slot, and validates the
declared and observed lengths. The stream is checksumed incrementally into a
server-generated path, fsynced, atomically renamed, then committed with the
matching `session_epoch` and `lease_epoch`. Disconnect, timeout, checksum, or
process failure removes only the uncommitted file and releases its lease.

Create idempotency compares owner, drive, operation, normalized target/name,
size, `ifMatch`, whole-file digest, and geometry. Reusing a key with any
different fingerprint returns `409 idempotency_conflict` without exposing the
old session. Finalization verifies complete ordered coverage, current auth and
replace preconditions, streams the staged parts, verifies byte count/digest,
and commits resource, manifest, audit, and receipt atomically.

Disk admission reserves remaining staging plus the full immutable destination;
active sessions, per-session parts, global streams, and finalizers are bounded.
Metrics and logs are low-cardinality and never contain file contents, names,
tokens, full paths, or upload IDs as labels.

## Rollout boundary

The public base owns the protocol, schema, relays, and generated-workload
inputs. Private infrastructure owns only explicit overlays and image pins.
`GFS_UPLOAD_V2_ENABLED=false` is the default and is the rollback switch. No
production enablement follows from this document. Any change to the protocol,
limits, state machine, ownership, or gates is an architecture/plan change and
requires a fresh GPT-5.6 Sol design review plus explicit user approval.

## Issue mapping

- **#282** — route-scoped metadata parsing and raw binary relay; do not raise
  the global JSON parser cap.
- **#285** — resumable upload behavior, retry/resume, response-loss and
  failure coverage; the indexed protocol replaces one-request streaming.
- **#286** — update the issue contract to describe resumable indexed parts, not
  a single streaming request.
- **#300** — Desktop IPC/memory boundary: v2 uses disk-backed, bounded parts
  and runtime capabilities instead of whole-file encoded content.

The live issue state and ownership are rechecked at PR0; this mapping is not a
substitute for current GitHub issue truth.
