import { createPortal } from 'react-dom'
import { ConfirmDialog } from '@components/ConfirmDialog'
import type { ChatDeleteConfirmationProps } from './types'

/**
 * The confirmation of a conversation's deletion.
 *
 * It portals to `<body>`. The chat header is translated away while the user
 * scrolls the thread, and a transformed ancestor becomes the containing block
 * of a `position: fixed` dialog — rendered in place, it could never cover the
 * app.
 */
export function ChatDeleteConfirmation({
  pending,
  title,
  onCancel,
  onConfirm,
}: ChatDeleteConfirmationProps) {
  if (!pending) return null
  return createPortal(
    <ConfirmDialog
      returnFocusTo={pending.returnFocusTo}
      fallbackFocusWithin={pending.fallbackFocusWithin}
      body={
        <>
          Delete <strong>{pending.title}</strong>? Messages cannot be recovered.
        </>
      }
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={title}
      tone="danger"
    />,
    document.body
  )
}
