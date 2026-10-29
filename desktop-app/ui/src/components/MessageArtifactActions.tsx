import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Flex, Modal, Spin, Tag, Typography } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HTML_PREVIEW_ARTIFACT_MAX_BYTES } from '@constants/htmlPreview'
import { extractArtifactNames } from '@lib/artifacts'

function ArtifactFileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 2.5h4.2L12 5.8v7.7H4.5z" />
      <path d="M8.7 2.5v3.3H12" />
    </svg>
  )
}

function ArtifactDownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5v7" />
      <path d="m4.8 6.6 3.2 3.2 3.2-3.2" />
      <path d="M3.5 12.5h9" />
    </svg>
  )
}

type MessageArtifactActionsProps = {
  hostRef: string
  content: string
}

type ArtifactInfo = {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const copy = new Uint8Array(view.byteLength)
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    return copy.buffer
  }
  if (value && typeof value === 'object') {
    const maybeBuffer = value as { data?: unknown }
    if (Array.isArray(maybeBuffer.data)) {
      return new Uint8Array(maybeBuffer.data.map(n => Number(n) || 0)).buffer
    }
  }
  throw new Error('Unexpected artifact payload shape')
}

function isHtmlArtifact(filename: string): boolean {
  return /\.html?$/i.test(filename)
}

function isMarkdownArtifact(filename: string): boolean {
  return /\.md$/i.test(filename)
}

function supportsPreview(filename: string): boolean {
  return isHtmlArtifact(filename) || isMarkdownArtifact(filename)
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getArtifactFormatLabel(artifact: ArtifactInfo): string {
  const format = artifact.format || artifact.name.split('.').pop() || 'file'
  return format.toUpperCase()
}

function getArtifactTypeLabel(artifact: ArtifactInfo): string {
  const format = (artifact.format || artifact.name.split('.').pop() || '').toLowerCase()
  if (format === 'md') return 'Markdown'
  if (format === 'pdf') return 'PDF'
  if (format === 'docx') return 'Word document'
  if (format === 'xlsx') return 'Spreadsheet'
  if (format === 'pptx') return 'Presentation'
  if (format === 'png') return 'PNG image'
  if (format === 'html' || format === 'htm') return 'HTML'
  if (format === 'json') return 'JSON'
  if (format === 'csv') return 'CSV'
  if (format === 'txt') return 'Text'
  return 'File'
}

function triggerBrowserDownload(filename: string, buffer: ArrayBuffer) {
  const blob = new Blob([buffer])
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function decodeText(buffer: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buffer)
}

export function MessageArtifactActions({ hostRef, content }: MessageArtifactActionsProps) {
  const mentionedFilenames = useMemo(() => extractArtifactNames(content), [content])
  const [availableArtifacts, setAvailableArtifacts] = useState<ArtifactInfo[] | null>(null)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [loadingPreviewFile, setLoadingPreviewFile] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [previewOpenByFile, setPreviewOpenByFile] = useState<Record<string, boolean>>({})
  const [htmlPreviewByFile, setHtmlPreviewByFile] = useState<Record<string, string>>({})
  const [markdownPreviewByFile, setMarkdownPreviewByFile] = useState<Record<string, string>>({})
  const [previewBlockedByFile, setPreviewBlockedByFile] = useState<Record<string, string>>({})
  const [fullscreenHtmlFile, setFullscreenHtmlFile] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadArtifactCatalog() {
      if (!hostRef || mentionedFilenames.length === 0) {
        setAvailableArtifacts(null)
        return
      }
      setCatalogLoading(true)
      setAvailableArtifacts(null)
      setCatalogUnavailable(false)
      setActionError(null)
      try {
        const result = await window.clerum.rpc.listArtifacts(hostRef, [hostRef])
        if (cancelled) return
        setAvailableArtifacts((result.artifacts || []).filter(item => item.name))
        setCatalogUnavailable(false)
      } catch (error) {
        if (cancelled) return
        setAvailableArtifacts([])
        setCatalogUnavailable(true)
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    }
    void loadArtifactCatalog()
    return () => {
      cancelled = true
    }
  }, [hostRef, mentionedFilenames])

  const artifacts = useMemo(() => {
    if (!availableArtifacts) return []
    if (catalogUnavailable) {
      return mentionedFilenames.map(name => {
        const format = name.split('.').pop() || 'file'
        return {
          name,
          format,
          sizeBytes: 0,
          createdAt: '',
        }
      })
    }
    const artifactByLowerName = new Map(
      availableArtifacts.map(artifact => [artifact.name.toLowerCase(), artifact])
    )
    return mentionedFilenames
      .map(name => artifactByLowerName.get(name.toLowerCase()))
      .filter((artifact): artifact is ArtifactInfo => Boolean(artifact))
  }, [availableArtifacts, catalogUnavailable, mentionedFilenames])

  const filenames = useMemo(() => artifacts.map(artifact => artifact.name), [artifacts])

  useEffect(() => {
    setPreviewOpenByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setHtmlPreviewByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setMarkdownPreviewByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setPreviewBlockedByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
  }, [filenames])

  const closeFullscreenHtml = () => {
    setFullscreenHtmlFile(previous => {
      if (previous) {
        setPreviewOpenByFile(current => ({ ...current, [previous]: false }))
      }
      return null
    })
  }

  if (!hostRef || mentionedFilenames.length === 0) return null

  async function fetchArtifactBuffer(filename: string): Promise<ArrayBuffer> {
    const payload = await window.clerum.rpc.downloadArtifact(hostRef, filename, [hostRef])
    return toArrayBuffer(payload)
  }

  async function handleDownload(filename: string) {
    setDownloadingFile(filename)
    setActionError(null)
    try {
      const buffer = await fetchArtifactBuffer(filename)
      triggerBrowserDownload(filename, buffer)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingFile(null)
    }
  }

  async function handleDownloadAll() {
    setDownloadingAll(true)
    setActionError(null)
    try {
      for (const artifact of artifacts) {
        const buffer = await fetchArtifactBuffer(artifact.name)
        triggerBrowserDownload(artifact.name, buffer)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingAll(false)
    }
  }

  async function handleTogglePreview(filename: string) {
    if (previewOpenByFile[filename]) {
      setPreviewOpenByFile(previous => ({ ...previous, [filename]: false }))
      return
    }

    setPreviewOpenByFile({ [filename]: true })
    if (isHtmlArtifact(filename) && htmlPreviewByFile[filename]) {
      setFullscreenHtmlFile(filename)
      return
    }
    if (htmlPreviewByFile[filename] || markdownPreviewByFile[filename]) {
      return
    }

    setLoadingPreviewFile(filename)
    setActionError(null)
    try {
      const buffer = await fetchArtifactBuffer(filename)
      const needsTextSafetyLimit = isHtmlArtifact(filename) || isMarkdownArtifact(filename)
      if (needsTextSafetyLimit && buffer.byteLength > HTML_PREVIEW_ARTIFACT_MAX_BYTES) {
        setPreviewBlockedByFile(previous => ({
          ...previous,
          [filename]: `Preview blocked: file exceeds safe limit (${Math.round(
            HTML_PREVIEW_ARTIFACT_MAX_BYTES / 1024
          )} KB). Download to inspect.`,
        }))
        return
      }
      if (isHtmlArtifact(filename)) {
        const html = decodeText(buffer)
        setHtmlPreviewByFile(previous => ({ ...previous, [filename]: html }))
        setFullscreenHtmlFile(filename)
      } else if (isMarkdownArtifact(filename)) {
        const markdown = decodeText(buffer)
        setMarkdownPreviewByFile(previous => ({ ...previous, [filename]: markdown }))
      }
      setPreviewBlockedByFile(previous => {
        const next = { ...previous }
        delete next[filename]
        return next
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setPreviewOpenByFile(previous => ({ ...previous, [filename]: false }))
    } finally {
      setLoadingPreviewFile(null)
    }
  }

  const visiblePreviews = filenames.filter(
    filename =>
      supportsPreview(filename) && previewOpenByFile[filename] && !isHtmlArtifact(filename)
  )

  if (!catalogLoading && availableArtifacts && artifacts.length === 0 && !actionError) return null

  return (
    <Flex vertical gap="small">
      {catalogLoading && <Spin size="small" description="Checking generated artifacts..." />}
      {catalogUnavailable && artifacts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Artifact catalog is unavailable right now. You can still try direct downloads."
        />
      )}
      {artifacts.length > 0 && (
        <Card
          size="small"
          title={
            <Flex align="center" gap="small">
              <ArtifactFileIcon />
              Generated files
            </Flex>
          }
          extra={
            artifacts.length > 1 ? (
              <Button
                type="link"
                loading={downloadingAll}
                disabled={Boolean(downloadingFile)}
                onClick={() => void handleDownloadAll()}
              >
                <span>Download all</span>
                <ArtifactDownloadIcon />
              </Button>
            ) : null
          }
        >
          <Flex vertical gap="small">
            {artifacts.map(artifact => (
              <Flex key={artifact.name} align="center" gap="small" wrap>
                <Tag>{getArtifactFormatLabel(artifact)}</Tag>
                <Flex vertical>
                  <Typography.Text>{artifact.name}</Typography.Text>
                  <Typography.Text type="secondary">
                    {getArtifactTypeLabel(artifact)} · {formatSize(artifact.sizeBytes)}
                  </Typography.Text>
                </Flex>
                <Flex align="center" gap="small">
                  {supportsPreview(artifact.name) && (
                    <Button
                      type="link"
                      onClick={() => void handleTogglePreview(artifact.name)}
                      loading={loadingPreviewFile === artifact.name}
                      aria-label={
                        previewOpenByFile[artifact.name]
                          ? `Hide ${artifact.name}`
                          : `Preview ${artifact.name}`
                      }
                    >
                      {previewOpenByFile[artifact.name] ? 'Hide' : 'Preview'}
                    </Button>
                  )}
                  <Button
                    type="primary"
                    loading={downloadingFile === artifact.name}
                    onClick={() => void handleDownload(artifact.name)}
                    disabled={downloadingFile === artifact.name || downloadingAll}
                    aria-label={`Download ${artifact.name}`}
                  >
                    <span>Download</span>
                    <ArtifactDownloadIcon />
                  </Button>
                </Flex>
              </Flex>
            ))}
          </Flex>
        </Card>
      )}
      {visiblePreviews.map(filename => (
        <Card key={filename} size="small" title={filename}>
          {previewBlockedByFile[filename] ? (
            <Alert type="warning" showIcon title={previewBlockedByFile[filename]} />
          ) : markdownPreviewByFile[filename] ? (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdownPreviewByFile[filename] || ''}
              </ReactMarkdown>
            </div>
          ) : (
            <Spin size="small" description="Preparing preview..." />
          )}
        </Card>
      ))}
      <Modal
        open={Boolean(fullscreenHtmlFile && htmlPreviewByFile[fullscreenHtmlFile])}
        title={
          <Flex vertical>
            <Typography.Text
              strong
            >{`Artifact preview: ${fullscreenHtmlFile ?? ''}`}</Typography.Text>
            <Typography.Text type="secondary">Untrusted HTML preview</Typography.Text>
          </Flex>
        }
        footer={null}
        onCancel={closeFullscreenHtml}
        destroyOnHidden
        width="90vw"
      >
        {fullscreenHtmlFile ? (
          <Flex vertical gap="small">
            <Button onClick={closeFullscreenHtml}>Back to chat</Button>
            <iframe
              className="message-html-preview-fullscreen-frame"
              title={`Artifact preview: ${fullscreenHtmlFile}`}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="eager"
              srcDoc={htmlPreviewByFile[fullscreenHtmlFile]}
            />
          </Flex>
        ) : null}
      </Modal>
      {actionError && <Alert type="error" showIcon title={actionError} />}
    </Flex>
  )
}
