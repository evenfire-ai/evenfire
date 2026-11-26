import type { BrowserSignInSnapshot } from '../../../../src/types'

export interface BrowserSignInPanelProps {
  /** The provider's label from main's login model. It is rendered as text only. */
  label: string
  /** Main's browser sign-in snapshot, the newest the renderer has seen (D13). */
  view: BrowserSignInSnapshot
  /** Set while another auth action runs: `booting`, `busy` or `authTransitioning` (D14, A3-68). */
  startDisabled: boolean
  onStart: () => void
  onCancel: () => void
}
