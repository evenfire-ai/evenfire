import { useEffect, useRef } from 'react'
import { Button, Flex, Modal, Typography } from 'antd'

export interface GfsMoveConfirmRequest {
  /** Sanitizable display facts of the moving folder. */
  sourceName: string
  destinationName: string
}

export interface GfsMoveConfirmDialogProps {
  request: GfsMoveConfirmRequest
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Folder drag-and-drop asks for confirmation before moving because inherited
 * access follows the new location. The drag gesture does not consent to a
 * numbered rename; files move without confirmation.
 */
export function GfsMoveConfirmDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsMoveConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Keep the established initial-focus and return-focus behavior. Ant Design
  // owns the modal focus trap and Escape handling while this component keeps
  // the invoking surface as its focus restoration target.
  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [])

  useEffect(() => {
    const keepTabInsideDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const panel = dialogRef.current?.closest<HTMLElement>('[role="dialog"]')
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => !element.closest('[hidden], [aria-hidden="true"]'))
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        event.preventDefault()
        panel.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', keepTabInsideDialog, true)
    return () => window.removeEventListener('keydown', keepTabInsideDialog, true)
  }, [])

  return (
    <Modal
      open
      title={
        <span aria-label={`Move folder ${request.sourceName} to ${request.destinationName}`}>
          Move “{request.sourceName}” to “{request.destinationName}”?
        </span>
      }
      onCancel={() => {
        if (!busy) onCancel()
      }}
      afterOpenChange={visible => {
        if (visible) cancelButtonRef.current?.focus()
      }}
      footer={
        <Flex justify="end" gap="small">
          <Button
            autoFocus
            disabled={busy}
            htmlType="button"
            onClick={onCancel}
            ref={cancelButtonRef}
          >
            Cancel
          </Button>
          <Button
            disabled={busy}
            htmlType="button"
            loading={busy}
            onClick={onConfirm}
            type="primary"
          >
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </Flex>
      }
      closable={false}
      destroyOnHidden
      keyboard={!busy}
      mask={{ closable: !busy }}
      panelRef={dialogRef}
    >
      <Flex vertical gap="middle">
        <Typography.Paragraph>
          Inherited access to this folder and its contents follows the new location. Direct sharing
          entries stay with their items — including any access they grant — and you may lose access.
        </Typography.Paragraph>
      </Flex>
    </Modal>
  )
}
