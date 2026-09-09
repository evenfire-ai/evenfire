# GFS upload collision and naming policy

Status: accepted for PR #595
Date: 2026-09-09

## 1. Problem and scope

Control UI and Desktop currently make the same product decisions in separate
page components: how to recognize a create-name collision, how to select a
numbered sibling name, when to retry, and how concurrent uploads reserve and
release candidate names. The duplicate implementations have already drifted:
the Control UI regression test used an Electron-shaped error even though its
real Upload v2 producer creates a structured fetch error.

This redesign establishes one pure behavioral authority. It does not share
React components, transport clients, upload execution, notifications, or
presentation between the applications.

## 2. Supported boundary and PR decision

The live repository boundaries were inspected before choosing a location:

| Existing boundary                                 | Intended ownership                                                    | Decision                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/frontend-components`                    | React 18 visual and semantic primitives for Control UI and Profile UI | Reject. Desktop intentionally uses React 19 and its own renderer primitives; collision policy is not visual. |
| `packages/desktop-app-links`                      | Desktop/profile link and packaging behavior                           | Reject. GFS upload naming is unrelated to link interpretation.                                               |
| `packages/display-field`                          | Control API/Control UI validation of admin display fields             | Reject. Extending it would blur a deliberately narrow validation contract.                                   |
| Dependency-free domain packages under `packages/` | Pure policy shared across otherwise separate consumers                | Use this established pattern for `packages/gfs-interaction-policy`.                                          |

`packages/gfs-interaction-policy` will be a browser-safe leaf with no React,
Node, transport, storage, or environment dependency. It will expose CommonJS
runtime code plus declarations, matching the repository's existing pure policy
packages. Both applications will depend on that same authority.

The redesign remains in PR #595. It is a bounded correction to collision
behavior already introduced by this PR, and splitting it would either leave
one client on duplicated policy or make this PR depend on an unmerged
prerequisite. Any backend protocol change, shared visual component, or broader
upload architecture change must be split into a separate proposal.

## 3. Decision table

| Situation                                                                                                           | Classification              | Candidate/operation decision                                                                                       | Reservation decision                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Preferred normalized name is absent from both the observed siblings and active reservations for the same parent     | Available                   | Attempt the preferred name                                                                                         | Reserve it before starting transport.                                                                              |
| Preferred name is occupied or reserved                                                                              | Local collision             | Select the first available ` (n)` suffix while preserving the extension and 255-character limit                    | Reserve the selected candidate atomically within the synchronous policy call.                                      |
| Upload v2 create responds with real HTTP 409; producer exposes `status`, optional parsed `code`, and parsed message | Remote collision            | For a fresh create with retry budget remaining, mark the attempted name occupied and retry with the next candidate | Retain attempt reservations until the operation settles so concurrent uploads cannot reuse an in-flight candidate. |
| Legacy Electron error contains the established 409/conflict or already-exists text but has no structured status     | Compatibility collision     | Apply the same bounded fresh-create retry                                                                          | Cover separately; it is not the primary Control UI fixture.                                                        |
| Conflict occurs while resuming a persisted Upload v2 session                                                        | Terminal for this operation | Do not rename; a persisted session is bound to its original identity                                               | Release all reservations when the operation exits.                                                                 |
| Error is not classified as a name collision                                                                         | Terminal error              | Surface through the owning application's existing error path                                                       | Release all reservations when the operation exits.                                                                 |
| Collision retry budget is exhausted                                                                                 | Terminal uniqueness error   | Surface `Could not create a unique GFS resource name.`                                                             | Release all reservations when the operation exits.                                                                 |
| Two uploads choose a name concurrently in one parent                                                                | Concurrent local collision  | First gets the preferred name; later reservations receive increasing numbered names                                | Reservations are isolated by parent and shared across concurrent operations in that client.                        |
| Equivalent names are uploaded to different parents                                                                  | Available in each parent    | Each parent may use the same preferred name                                                                        | Reservation sets never leak across parent keys.                                                                    |
| Upload succeeds, fails, is canceled, or returns early                                                               | Settled                     | Application performs its existing UI/state work                                                                    | A `finally` path releases every name reserved by that operation and removes empty parent buckets.                  |

## 4. Behavioral invariants

1. Callers normalize and validate a source name before asking the policy to
   reserve or suffix it; the policy owns deterministic NFC comparison and
   numbered-name selection after that precondition.
2. The extension remains last, suffixes start at ` (1)`, and every candidate
   stays within 255 characters using the existing deterministic truncation
   rule.
3. One exported classifier owns structured 409 and legacy compatibility
   recognition. Neither client may duplicate status/message regular
   expressions.
4. The real Control UI Upload v2 fetch producer is the primary regression
   contract: its numeric `status`, optional parsed `code`, and parsed message
   must reach the shared classifier unchanged.
5. Name retries are create-only, bounded, and never rename a persisted resume
   session.
6. A reservation is acquired before transport begins. Reservations are scoped
   to a parent, distinguish concurrent operations, and are all released on
   success, failure, cancellation, early return, or retry exhaustion.
7. A remote collision is added to the operation's observed occupied names
   before choosing the next candidate, even when the initial directory listing
   was stale.
8. Control UI and Desktop produce the same collision decision and candidate
   sequence for equivalent inputs.
9. App-specific transport, React state, abort/session handling, notifications,
   and rendering remain in their current application boundaries.

## 5. Required proof

- Package-level decision-table tests cover structured Upload v2 errors,
  separately labeled legacy errors, numbering/truncation, parent isolation,
  concurrent reservations, bounded retry decisions, and complete cleanup.
- Control UI drives `GfsBrowser` through the real fetch-based Upload v2
  producer: first create returns 409, the produced error shape is asserted,
  and the observable second upload uses `report (1).txt` and completes.
- Desktop and Control UI tests prove both consumers import the same package
  authority and produce equivalent candidates for equivalent inputs.
- T3 regression evidence runs the producer-backed assertion against the
  relevant pre-fix commit in an isolated checkout and records that it fails
  because the previous browser path did not consume the real producer-backed
  conflict behavior.
- The repository strict style-rule command passes after the Move Dialog token
  cleanup.

## 6. T3 regression evidence

The producer-backed browser assertion was run in an isolated local clone at
`5eb0bf4e8884183df7bac9cb6aa5f85f0acac5ce`, the parent of the Control UI
collision-retry implementation. The real Upload v2 producer emitted and the
test verified `status: 409`, `code: conflict`, and the parsed message
`409 resource already exists`. The assertion then failed for the intended
behavioral reason:

```text
expected [ 'report.txt' ] to deeply equal [ 'report.txt', 'report (1).txt' ]
```

That head attempted the original name once, surfaced the 409, and never issued
the numbered retry. The same producer-backed assertion passes with this design.
