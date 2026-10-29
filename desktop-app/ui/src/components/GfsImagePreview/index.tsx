import { useId, useRef } from 'react'
import { Modal, Result, Typography } from 'antd'
import { IconClose } from '@components/SidebarNav/icons'
import { useWorkspaceModalStyle } from '@hooks/useWorkspaceModalStyle'
import { GfsImagePreviewBody } from './Body'
import type { GfsImagePreviewProps } from './types'

/**
 * Ant Design modal chrome around the specialized image renderer. The existing
 * workspace-relative positioning remains owned by the layout hook; the body
 * retains its bounded fetch, object URL lifecycle, and copy behavior.
 */
export function GfsImagePreview({
  byteLength,
  fileName,
  gfsUri,
  dataBase64,
  mimeType,
  onClose,
  reloadVersion,
  unavailable = false,
  onDownloadError,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const modalPanelRef = useRef<HTMLDivElement | null>(null)
  const rootStyle = useWorkspaceModalStyle()

  return (
    <Modal
      open
      title={
        <Typography.Title id={titleId} level={3}>
          {unavailable ? 'File unavailable' : fileName}
        </Typography.Title>
      }
      onCancel={onClose}
      afterOpenChange={visible => {
        if (visible) {
          modalPanelRef.current?.querySelector<HTMLElement>('.ant-modal-close')?.focus()
        }
      }}
      closable={{
        'aria-label': 'Close image preview',
        closeIcon: <IconClose aria-hidden="true" width={18} height={18} />,
      }}
      destroyOnHidden
      footer={null}
      keyboard
      panelRef={modalPanelRef}
      styles={{ root: rootStyle }}
    >
      {unavailable ? (
        <Result status="warning" subTitle="This item is no longer available." />
      ) : (
        <GfsImagePreviewBody
          key={`${gfsUri}:${reloadVersion ?? 0}`}
          byteLength={byteLength}
          fileName={fileName}
          gfsUri={gfsUri}
          dataBase64={dataBase64}
          mimeType={mimeType}
          onDownloadError={onDownloadError}
          hideTitle
        />
      )}
    </Modal>
  )
}

export { GfsImagePreviewBody } from './Body'
export type { GfsImagePreviewProps, GfsImagePreviewSource } from './types'
