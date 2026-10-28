import { useRef } from 'react'
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

  return (
    <Modal
      open
      title={title}
      onCancel={onCancel}
      afterOpenChange={visible => {
        if (visible) cancelButtonRef.current?.focus()
      }}
      footer={
        <Flex justify="end" gap="small">
          <Button htmlType="button" onClick={onCancel} ref={cancelButtonRef} size="small">
            {cancelLabel}
          </Button>
          <Button
            danger={tone === 'danger'}
            htmlType="button"
            onClick={onConfirm}
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
