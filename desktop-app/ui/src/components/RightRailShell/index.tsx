import type { CSSProperties } from 'react'
import type { RightRailShellProps } from './types'

/**
 * Generic right-rail shell: the fixed right column (`top`/`right`/`bottom`/
 * `width`) that a single occupant fills at a time (mini-spec 04a §B, decision
 * E). It owns ONLY the rail geometry — the shared `--rail-*` tokens and the
 * fixed positioning — never any occupant chrome or the arbitration of WHICH
 * occupant is shown. Single-occupant (XOR) is expressed by the `occupant` prop:
 * the caller passes exactly one occupant (or `null`), so two occupants can never
 * paint the rail at once.
 *
 * The contract is designed for TWO occupants — `chat-drawer | notification-tray`
 * — but in 04a only the chat drawer enters the rail. The notification tray keeps
 * its current positioning (popover on DOM tabs, its own app-drawer form on app
 * tabs, coordinated by App's existing `notificationTrayUsesDrawer` XOR); its
 * migration into this shell is deferred to
 * `work-tracker/issues/26-09-17-desktop-notification-tray-right-rail-shell.md`.
 * Adding it later is a new `data-occupant` value plus its width/top wiring — no
 * change to this component's geometry contract.
 */
export function RightRailShell({ occupant, width, top, children }: RightRailShellProps) {
  if (!occupant) return null
  const style = {
    '--rail-width': `${width}px`,
    // Publish the measured top only when we have one; otherwise the CSS fallback
    // applies (null — not 0 — so a legitimate rect.top of 0 still positions).
    ...(top !== null && top !== undefined ? { '--rail-top': `${top}px` } : {}),
  } as CSSProperties
  return (
    <div className="right-rail-shell" data-occupant={occupant} style={style}>
      {children}
    </div>
  )
}
