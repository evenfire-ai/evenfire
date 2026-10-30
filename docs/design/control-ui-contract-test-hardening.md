# Control UI Contract Test Hardening — Mini-spec

> **Status:** Pre-implementation design record for PR #298.
>
> **Scope:** Test methodology and test fixtures in `control-ui`. Production
> behavior and API wire contracts do not change.

## Problem

The control UI has deterministic merge, sorting, credential reconciliation, and
optimistic-concurrency helpers. Its current tests use hand-picked examples, so
they do not exercise the broader input domain. Several consumer tests also
repeat Context and Secret API response literals, allowing those fixtures to
drift independently of the producer contracts pinned in `control-api` tests.

## Design decisions

### Generated invariant coverage

`fast-check` is a `control-ui` development dependency. Existing example tests
remain as readable regressions; generated properties supplement them.

The locked properties are:

- Null-last sorting preserves the input multiset, keeps nullish values last in
  both directions, is deterministic and idempotent, and delegates comparisons
  between two non-null values.
- Connector access merging is unique by principal ID, union-complete,
  deterministically sorted by label then ID, permutation-stable, and idempotent.
  Duplicate IDs deterministically retain the minimum principal by that order.
- Connector Context names come only from current Context allowlists, are
  non-blank, unique, sorted, and independent of Context input order.
- Credential reconciliation emits each schema key once at the front in schema
  order, preserves already-bound values, adopts at most one unbound value,
  remains stable for uniquely bound rows, and agrees with required-field
  completeness after reconciliation.
- Context update payloads preserve the exact spec reference and a trimmed,
  non-blank `resourceVersion`. Missing versions fail closed. HTTP 409 errors map
  to the stale-write conflict copy; other errors retain their message or use the
  caller fallback.

### Producer-shaped consumer fixtures

Two shared factories under `control-ui/test/fixtures` are the only place UI
tests construct these producer response shapes:

- Context resources contain `metadata.name`, `metadata.namespace`,
  `metadata.resourceVersion`, the complete Context `spec`, and `status`.
- Secret summaries contain only `name` and `keys`; they never contain values or
  Kubernetes metadata.

Consumer tests import these factories instead of hand-writing list responses.
Contract-lock tests assert the factories' complete key sets against the wire
shapes pinned by `control-api/test/routes.resources.test.ts` and
`control-api/test/routes.secrets.test.ts`.

## Validation

1. Run the four generated-property test files directly.
2. Run both fixture contract-lock tests.
3. Run every migrated Context and Secret consumer test.
4. Run full `control-ui` TypeScript checking and the complete Vitest suite.

## Non-goals

- Moving serializers across the `control-api` and `control-ui` package boundary.
- Changing Context or Secret production response formats.
- Changing the behavior of the four helper groups.
