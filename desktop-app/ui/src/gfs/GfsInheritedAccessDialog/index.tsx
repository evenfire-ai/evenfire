import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Flex, Modal, Tag, Typography } from 'antd'
import type { GfsInheritedAccessDialogProps, GfsInheritedAccessRole } from './types'

/**
 * Google-Drive-style confirmation for editing an inherited access row in the
 * Share dialog: the member's access is configured on a parent folder, so any
 * role change (or removal) is applied there and cascades to everything inside
 * the folder. "Learn more" swaps the confirmation for a short help panel
 * explaining the cascade and the limited-access-folder alternative.
 */

const ROLE_LABELS: Record<GfsInheritedAccessRole, string> = {
  read: 'Read',
  editor: 'Editor',
}

const HELP_POINTS = [
  "A folder's permissions apply to every file and subfolder inside it.",
  "You can't give someone less access on a single file than they have on its parent folder.",
  'To limit access to one file, create a folder with limited access and share the file from there.',
]

export function GfsInheritedAccessDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsInheritedAccessDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  // Keyed on open/close transitions, not the request object identity: the
  // parent rebuilds the request object on every render, and refiring per
  // render would reset the help view and steal focus mid-dialog.
  const open = request !== null

  useEffect(() => {
    setShowHelp(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousActiveElementRef.current = previousActiveElement
    cancelButtonRef.current?.focus()
    return () => {
      previousActiveElementRef.current?.focus()
    }
  }, [open])

  if (!request) return null

  const isRemove = request.mode === 'remove'
  const nextLabel = isRemove ? 'Remove' : request.nextRole ? ROLE_LABELS[request.nextRole] : ''
  const title = isRemove ? 'Remove from parent folder?' : 'Update role on parent folder?'
  const lead = isRemove
    ? `Removing ${request.memberLabel} from this item will also remove them from a parent folder.`
    : `Changing ${request.memberLabel}'s permissions on this item will also change permissions on a parent folder.`
  const transitions = [
    ...request.folders.map(folder => ({
      key: folder.resourceId,
      label: folder.name,
      currentRole: ROLE_LABELS[folder.currentRole],
    })),
    {
      key: 'current-file',
      label: request.fileName,
      currentRole: ROLE_LABELS[request.fileCurrentRole],
    },
  ]

  return (
    <Modal
      open={open}
      title={showHelp ? 'How sharing works in EvenDrive' : title}
      onCancel={() => {
        if (!busy) onCancel()
      }}
      afterOpenChange={visible => {
        if (visible) cancelButtonRef.current?.focus()
      }}
      footer={
        <Flex justify="end" gap="small">
          {showHelp ? (
            <Button htmlType="button" onClick={() => setShowHelp(false)} size="small">
              Back
            </Button>
          ) : (
            <>
              <Button
                autoFocus
                disabled={busy}
                htmlType="button"
                onClick={onCancel}
                ref={cancelButtonRef}
                size="small"
              >
                Cancel
              </Button>
              <Button
                danger={isRemove}
                htmlType="button"
                loading={busy}
                onClick={onConfirm}
                size="small"
                type="primary"
              >
                {isRemove ? 'Remove' : 'Update role'}
              </Button>
            </>
          )}
        </Flex>
      }
      closable={false}
      destroyOnHidden
      keyboard={!busy}
      mask={{ closable: !busy }}
    >
      {showHelp ? (
        <ul>
          {HELP_POINTS.map(point => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      ) : (
        <Flex vertical gap="middle">
          <Typography.Paragraph>
            {lead} Alternatively, create a folder with limited access.{' '}
            <Button htmlType="button" onClick={() => setShowHelp(true)} size="small" type="link">
              Learn more
            </Button>
          </Typography.Paragraph>
          <Descriptions
            column={1}
            items={transitions.map(transition => ({
              key: transition.key,
              label: transition.label,
              children: (
                <Flex align="center" gap="small">
                  <Tag>{transition.currentRole}</Tag>
                  <span aria-hidden="true">→</span>
                  <Tag color={isRemove ? 'error' : 'processing'}>{nextLabel}</Tag>
                </Flex>
              ),
            }))}
            size="small"
          />
          {request.residualEditorFolderNames && request.residualEditorFolderNames.length > 0 ? (
            <Alert
              showIcon
              type="warning"
              title={`Sharing entries on ${request.residualEditorFolderNames.join(', ')} still grant Editor access. This change does not remove them.`}
            />
          ) : null}
        </Flex>
      )}
    </Modal>
  )
}
