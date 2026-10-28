import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Flex, Modal, Tag, Typography } from 'antd'
import {
  HTML_PREVIEW_ACTIVE_SANDBOX,
  HTML_PREVIEW_ALLOW_ACTIVE_MODE,
  HTML_PREVIEW_SAFE_SANDBOX,
  HTML_PREVIEW_TIMEOUT_MS,
} from '@constants/htmlPreview'

type SecureHtmlPreviewProps = {
  html: string
  previewId: string
  title: string
  maxBytes: number
  fullscreenOnly?: boolean
  onRequestClose?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SecureHtmlPreview({
  html,
  previewId,
  title,
  maxBytes,
  fullscreenOnly = false,
  onRequestClose,
}: SecureHtmlPreviewProps) {
  const [loaded, setLoaded] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [activeModeEnabled, setActiveModeEnabled] = useState(false)
  const [fullViewOpen, setFullViewOpen] = useState(false)
  const htmlSizeBytes = useMemo(() => new TextEncoder().encode(html).byteLength, [html])
  const exceedsSizeLimit = htmlSizeBytes > maxBytes

  useEffect(() => {
    setLoaded(false)
    setTimedOut(false)
  }, [html, activeModeEnabled])

  useEffect(() => {
    if (!fullscreenOnly) return
    setFullViewOpen(true)
  }, [fullscreenOnly, html, previewId])

  useEffect(() => {
    if (!fullscreenOnly || fullViewOpen) return
    onRequestClose?.()
  }, [fullViewOpen, fullscreenOnly, onRequestClose])

  useEffect(() => {
    if (loaded || exceedsSizeLimit) return
    const timer = window.setTimeout(() => {
      setTimedOut(true)
    }, HTML_PREVIEW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [exceedsSizeLimit, loaded, html, activeModeEnabled])

  const handleDownload = () => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeTitle =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'html-preview'
    link.href = objectUrl
    link.download = `${safeTitle}-${previewId.slice(0, 8)}.html`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(objectUrl)
  }

  const renderInlinePreviewContent = () => {
    if (exceedsSizeLimit) {
      return (
        <Alert
          type="warning"
          showIcon
          title={`Preview blocked: HTML exceeds safe limit (${formatBytes(maxBytes)}).`}
        />
      )
    }
    if (timedOut) {
      return (
        <Alert
          type="warning"
          showIcon
          title="Preview timed out. Open the full view or download the file instead."
        />
      )
    }
    return (
      <iframe
        className="message-html-preview-frame"
        title={`${title} ${previewId}`}
        sandbox={activeModeEnabled ? HTML_PREVIEW_ACTIVE_SANDBOX : HTML_PREVIEW_SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={html}
        onLoad={() => setLoaded(true)}
      />
    )
  }

  const renderFullscreenPreviewContent = () => {
    return (
      <iframe
        className="message-html-preview-fullscreen-frame"
        title={`${title} full ${previewId}`}
        sandbox={activeModeEnabled ? HTML_PREVIEW_ACTIVE_SANDBOX : HTML_PREVIEW_SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        loading="eager"
        srcDoc={html}
      />
    )
  }

  const fullscreenModal = (
    <Modal
      open={fullViewOpen}
      title={
        <Flex vertical>
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary">{formatBytes(htmlSizeBytes)}</Typography.Text>
        </Flex>
      }
      footer={null}
      onCancel={() => setFullViewOpen(false)}
      destroyOnHidden
      width="90vw"
    >
      {renderFullscreenPreviewContent()}
    </Modal>
  )

  if (fullscreenOnly) {
    return fullscreenModal
  }

  return (
    <Card
      size="small"
      title={title}
      extra={<Tag>{formatBytes(htmlSizeBytes)}</Tag>}
      aria-label={title}
    >
      <Flex vertical gap="small">
        <Alert
          type="warning"
          showIcon
          title="Untrusted HTML preview. Review carefully before interacting."
        />
        <Flex align="center" gap="small" wrap>
          <Button onClick={() => setFullViewOpen(true)}>Open full view</Button>
          <Button onClick={handleDownload}>Download HTML</Button>
          {HTML_PREVIEW_ALLOW_ACTIVE_MODE && (
            <Button onClick={() => setActiveModeEnabled(previous => !previous)}>
              {activeModeEnabled ? 'Disable active HTML' : 'Enable active HTML'}
            </Button>
          )}
        </Flex>
        {renderInlinePreviewContent()}
      </Flex>
      {fullscreenModal}
    </Card>
  )
}
