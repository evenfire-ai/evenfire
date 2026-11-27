# Conversation action behavior (round 3 design stop)

Rename and confirmed deletion are separate interactions; neither needs a mutation framework.

## Rename editor

Each `start` creates a new editing attempt, including repeated starts for the same
conversation. It owns its baseline and draft. Commit closes the editor and hands
that attempt's key and draft to the rename producer. Success never changes editor
state. Failure reports the rejected operation, but restores its draft only if no
later start or cancel has taken ownership. Cancel invalidates restoration even
when the editor is already closed. Unmount invalidates all completions. Untouched,
blank, duplicate blur and IME Enter behavior stays unchanged. An independent test
model will enumerate start/change/commit/resolve/reject/cancel interleavings and
compare the observable editor against the hook, including multiple pending
attempts and repeated keys.

## Confirmed deletion

A request owns its captured agent/chat identity and authority fence. Only the
latest request may open a confirmation. Cancel invalidates pending captures.
Confirmation reports a shell overlay and disables duplicate confirm/dismissal
while the mutation is pending. The real deletion controller returns exactly one
of three storage/authority outcomes:

- `deleted`: storage deletion committed, including deferred transcript cleanup;
  close only the matching request. Navigation failure does not make a committed
  deletion retryable. Raw awaiters still receive the original successor-navigation
  rejection; the confirmation closes without offering another deletion.
- `retryable-failure`: storage failed while the original authority and captured
  binding/session generations remain valid; report the error and retain that
  same confirmation and fence for retry or cancel.
- `stale-authority`: the user/team/Host authority or store fence changed, or a
  fresh fence cannot be verified; close the matching confirmation. Require a new
  explicit request and capture; never silently rebind a retry.

Late completion cannot dismiss a newer request. Team/Host changes never retarget
an operation. Preserve all existing main-process fence checks, ack-before-delete
ordering, navigation guards, and operation-scoped feedback. Integration tests
must drive the actual controller and action adapter, injecting failure only at
its storage boundary, and cover storage retry, team/Host invalidation, late
completion, and successful/deferred cleanup.

## Dialog focus

Reuse the Desktop shared `ConfirmDialog` for keyboard containment and restoration.
Capture the initiating options button before asynchronous fence capture. Cancel
returns there. If deletion removes it, focus a surviving conversation control
or navigation control. A pending operation keeps focus in the dialog even while
buttons are disabled. No per-surface focus trap.

## Review evidence

Unit and producer integration tests are required. Browser checks remain unverified;
the round-3 review records the owner's waiver of further Playwright execution.
Do not describe those checks as passing.
