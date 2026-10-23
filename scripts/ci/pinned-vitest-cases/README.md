# Pinned Vitest cases

These manifests are used by `assert-pinned-vitest-suites.mjs --cases`. A pin names one Vitest suite
by its exact file suffix and one assertion by its exact `fullName`. CI first applies the existing
whole-file check, then requires every pinned case to appear exactly once and pass.

The pins guard against merge resolutions that delete, rename, skip, or fail a critical case while
leaving its suite green. An intentional test rename must update the reviewed pin in the same change.

These are Vitest-only witnesses. Contract `node:test` suites, real-PostgreSQL lanes, and runtime
validation have their own gates. A passing pinned case proves execution and status, not that the
test's assertions or documentation remain meaningful; producer review and mutation evidence still
own that claim.
