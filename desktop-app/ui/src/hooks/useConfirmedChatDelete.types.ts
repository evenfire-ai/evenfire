import type { QueuedChatDelete } from '@contexts/AgentChatActionsContext'

/** The conversation a deletion was requested for. */
export type ConfirmedChatDeleteTarget = {
  agentRef: string
  chatId: string
  title: string
  returnFocusTo?: HTMLElement | null
  fallbackFocusWithin?: HTMLElement | null
}

/** A requested deletion, held until the user confirms or cancels it. */
export type PendingChatDelete = ConfirmedChatDeleteTarget & {
  deletion: QueuedChatDelete
}

export type ConfirmedChatDeleteController = {
  /** The deletion awaiting a decision, or null when none is. */
  pending: PendingChatDelete | null
  /** Captures the delete fence, then opens the confirmation. */
  request: (target: ConfirmedChatDeleteTarget) => Promise<void>
  cancel: () => void
  /** Runs the deletion and resolves once it has completed. */
  confirm: () => Promise<void>
}
