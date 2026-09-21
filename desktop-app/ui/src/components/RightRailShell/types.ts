import type { ReactNode } from 'react'

/**
 * The two things that can occupy the right rail. The rail admits a SINGLE
 * occupant at a time (XOR): while one holds the rail the other falls back to its
 * own non-rail form. In 04a only `chat-drawer` ever enters the rail; the
 * `notification-tray` occupant is part of the contract but its migration is
 * deferred (see the RightRailShell doc comment / issue
 * `26-09-17-desktop-notification-tray-right-rail-shell`).
 */
export type RightRailOccupant = 'chat-drawer' | 'notification-tray'

export type RightRailShellProps = {
  /**
   * Which occupant currently holds the rail, or `null` when the rail is empty.
   * The caller resolves the XOR/precedence (04a: the chat drawer wins the rail
   * and the tray falls to its popover form) BEFORE choosing what to render here;
   * the shell does not arbitrate between occupants.
   */
  occupant: RightRailOccupant | null
  /** Rail width in px (the occupant derives it from its own width token). */
  width: number
  /**
   * Measured top of the rail in px, or `null`/`undefined` to use the static CSS
   * fallback. App tabs pass the embed-measured top so the rail follows the
   * embed's header; DOM tabs pass `null` (no native view to align to, so the
   * static fallback avoids the "waiting for a measurement that never arrives"
   * trap — mini-spec 04a §A2).
   */
  top?: number | null
  /** The occupant's content (04a: the `<ChatDrawer>`). */
  children: ReactNode
}
