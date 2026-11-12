# Embedded Notification Rail Mini-spec

## Decision

When a live embedded app is open and the chat drawer is closed, the notification
drawer occupies the full horizontal rail between the embedded app slot's measured
right edge and the desktop window's existing right inset.

## Invariants

- The drawer tracks the same measured slot rectangle used for the native
  `WebContentsView`; it does not infer its left edge from a viewport-width clamp.
- The drawer preserves its existing titlebar clearance, right inset, bottom inset,
  readiness gate, and notification behavior.
- When the chat drawer is visible, notifications retain their existing overlay
  presentation. The embedded-app drawer rail is not mounted in that state.
- Before an embedded app reports a slot rectangle, the drawer retains its current
  bounded fallback geometry rather than rendering an unbounded surface.

## Verification

Browser coverage must prove that an aligned embedded-app notification drawer
starts at the measured embed-slot edge and ends at the existing right inset.
