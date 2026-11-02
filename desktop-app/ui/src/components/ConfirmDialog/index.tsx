import { useRef, useState } from 'react'
import { Button, Flex, Modal } from 'antd'
import type { ConfirmDialogProps } from './types'

export function ConfirmDialog({
  body,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  title,
  tone = 'primary',
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const onCancelRef = useRef(onCancel)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  onCancelRef.current = onCancel

  const handleConfirm = () => {
    if (pendingRef.current) return
    const result = onConfirm()
    if (!result || typeof result.then !== 'function') return

    pendingRef.current = true
    setPending(true)
    void Promise.resolve(result).finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }

  return (
    <Modal
      open
      title={title}
      aria-busy={pending}
      onCancel={() => {
        if (!pendingRef.current) onCancelRef.current()
      }}
      footer={
        <Flex justify="end" gap="small">
          <Button
            autoFocus
            disabled={pending}
            htmlType="button"
            onClick={() => {
              if (!pendingRef.current) onCancelRef.current()
            }}
            ref={cancelButtonRef}
            size="small"
          >
            {cancelLabel}
          </Button>
          <Button
            aria-busy={pending}
            danger={tone === 'danger'}
            disabled={pending}
            loading={pending}
            htmlType="button"
            onClick={handleConfirm}
            size="small"
            type="primary"
          >
            {confirmLabel}
          </Button>
        </Flex>
      }
      closable={false}
      keyboard
      maskClosable
      destroyOnHidden
    >
      {body}
    </Modal>
  )
}
