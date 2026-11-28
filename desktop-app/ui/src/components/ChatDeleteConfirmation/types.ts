import type { PendingChatDelete } from '@hooks/useConfirmedChatDelete.types'

export type ChatDeleteConfirmationProps = {
  /** The deletion to confirm. Nothing renders while it is null. */
  pending: PendingChatDelete | null
  /** Dialog heading, naming what the surface calls a conversation. */
  title: string
  onCancel: () => void
  /** The deletion; the dialog stays busy until it settles. */
  onConfirm: () => void | Promise<unknown>
}
