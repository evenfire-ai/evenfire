import type { ChatMessageAttachment } from '../../../src/types'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../uiTypes'

type ParsedChatMessageDisplay = {
  content: string
  attachments: ChatMessageAttachment[]
}

function attachmentOrder(value: { addedOrder?: number }, fallbackIndex: number): number {
  return value.addedOrder ?? fallbackIndex
}

function formatUploadedFileTooltip(attachment: ComposerImageAttachment): string {
  return `Uploaded File - ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`
}

function normalizeAttachmentLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

function formatParsedAttachmentLabel(type: ChatMessageAttachment['type'], label: string): string {
  const normalizedLabel = normalizeAttachmentLabel(label)
  if (type === 'global_file') {
    const labeledReference = normalizedLabel.match(/^(.*?)\s+\(gfs:\/\/[^)]+\)$/i)
    if (labeledReference?.[1]?.trim()) return labeledReference[1].trim()
    const normalizedPath = normalizedLabel.replace(/^gfs:\/\/[^/]+\//i, '').replace(/\/+$/g, '')
    const basename = normalizedPath.split('/').filter(Boolean).pop()
    if (!basename) return normalizedLabel
    try {
      return decodeURIComponent(basename)
    } catch {
      return basename
    }
  }
  if (type !== 'agent_file') return normalizedLabel
  const normalizedPath = normalizedLabel.replace(/^\/+|\/+$/g, '')
  return normalizedPath.split('/').filter(Boolean).pop() || normalizedLabel
}

function createParsedAttachment(
  type: ChatMessageAttachment['type'],
  label: string,
  index: number
): ChatMessageAttachment | null {
  const normalizedLabel = formatParsedAttachmentLabel(type, label)
  if (!normalizedLabel) return null
  return {
    id: `parsed:${type}:${index}:${normalizedLabel}`,
    type,
    label: normalizedLabel,
    addedOrder: index,
  }
}

function inferLegacyContextAttachmentType(label: string): ChatMessageAttachment['type'] {
  const normalizedLabel = label.trim().toLowerCase()
  if (normalizedLabel.startsWith('mcp-') || normalizedLabel.endsWith('-remote')) {
    return 'connector'
  }
  if (normalizedLabel.includes('/') || /\.[a-z0-9]{2,6}$/i.test(normalizedLabel)) {
    return 'agent_file'
  }
  return 'plugin'
}

function parseAttachmentList(value: string): string[] {
  const itemList = value.split(/\.\s+/)[0] ?? ''
  return itemList
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

export function buildChatMessageAttachments(
  imageAttachments: ComposerImageAttachment[],
  referenceAttachments: ComposerReferenceAttachment[]
): ChatMessageAttachment[] {
  const referenceItems = referenceAttachments.map((attachment, index): ChatMessageAttachment => {
    const type = attachment.type
    return {
      id: attachment.id,
      type,
      label: attachment.label,
      tooltip:
        attachment.type === 'plugin'
          ? 'Plugin'
          : attachment.type === 'connector'
            ? 'Connector'
            : attachment.type === 'global_file'
              ? 'Global File'
              : 'Agent File',
      addedOrder: attachmentOrder(attachment, index),
    }
  })
  const imageItems = imageAttachments.map((attachment, index): ChatMessageAttachment => {
    const fallbackIndex = referenceItems.length + index
    return {
      id: attachment.id,
      type: 'uploaded_file',
      label: attachment.name,
      tooltip: formatUploadedFileTooltip(attachment),
      addedOrder: attachmentOrder(attachment, fallbackIndex),
    }
  })
  return [...referenceItems, ...imageItems].sort(
    (a, b) => attachmentOrder(a, 0) - attachmentOrder(b, 0)
  )
}

export function getChatMessageAttachmentTypeLabel(type: ChatMessageAttachment['type']): string {
  if (type === 'plugin') return 'Plugin'
  if (type === 'connector') return 'Connector'
  if (type === 'agent_file') return 'Agent File'
  if (type === 'global_file') return 'Global File'
  if (type === 'response_file') return 'Generated File'
  return 'Uploaded File'
}

export function buildResponseFileAttachments(response: unknown): ChatMessageAttachment[] {
  const record =
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {}
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : []
  return rawAttachments
    .map((raw, index): ChatMessageAttachment | null => {
      const attachment =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null
      if (!attachment) return null
      if (attachment.kind !== 'file') return null
      if (attachment.encoding !== 'base64') return null
      const filename =
        typeof attachment.filename === 'string' && attachment.filename.trim()
          ? attachment.filename.trim()
          : ''
      const dataBase64 =
        typeof attachment.dataBase64 === 'string' && attachment.dataBase64
          ? attachment.dataBase64
          : ''
      if (!filename || !dataBase64) return null
      const mimeType =
        typeof attachment.mimeType === 'string' && attachment.mimeType.trim()
          ? attachment.mimeType.trim()
          : 'application/octet-stream'
      const sizeBytes =
        typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
          ? attachment.sizeBytes
          : undefined
      return {
        id:
          typeof attachment.id === 'string' && attachment.id.trim()
            ? attachment.id.trim()
            : `response-file:${index}:${filename}`,
        type: 'response_file',
        label: filename,
        tooltip: sizeBytes
          ? `Generated File - ${Math.max(1, Math.round(sizeBytes / 1024))} KB`
          : 'Generated File',
        addedOrder: index,
        filename,
        mimeType,
        encoding: 'base64',
        dataBase64,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      }
    })
    .filter((attachment): attachment is ChatMessageAttachment => attachment !== null)
}

export function parseChatMessageDisplay(content: string): ParsedChatMessageDisplay {
  const lines = content.split('\n')
  const visibleLines: string[] = []
  const attachments: ChatMessageAttachment[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''
    const trimmedLine = line.trim()

    if (trimmedLine === '[Attached context]' || trimmedLine === '[Attached images]') {
      const markerType = trimmedLine === '[Attached images]' ? 'uploaded_file' : null
      lineIndex += 1
      while (lineIndex < lines.length) {
        const itemLine = lines[lineIndex] ?? ''
        const trimmedItemLine = itemLine.trim()
        if (!trimmedItemLine) {
          lineIndex += 1
          continue
        }
        if (!trimmedItemLine.startsWith('- ')) break
        const label = trimmedItemLine.slice(2)
        const type = markerType ?? inferLegacyContextAttachmentType(label)
        const attachment = createParsedAttachment(type, label, attachments.length)
        if (attachment) attachments.push(attachment)
        lineIndex += 1
      }
      continue
    }

    if (trimmedLine.startsWith('USER-ATTACHED CONTEXT:')) {
      lineIndex += 1
      while (lineIndex < lines.length) {
        const promptLine = (lines[lineIndex] ?? '').trim()
        if (!promptLine) {
          lineIndex += 1
          continue
        }
        if (promptLine.startsWith('Plugins:')) {
          for (const label of parseAttachmentList(promptLine.slice('Plugins:'.length))) {
            const attachment = createParsedAttachment('plugin', label, attachments.length)
            if (attachment) attachments.push(attachment)
          }
        } else if (promptLine.startsWith('Connectors:')) {
          for (const label of parseAttachmentList(promptLine.slice('Connectors:'.length))) {
            const attachment = createParsedAttachment('connector', label, attachments.length)
            if (attachment) attachments.push(attachment)
          }
        } else if (promptLine.startsWith('Agent Files:')) {
          for (const label of parseAttachmentList(promptLine.slice('Agent Files:'.length))) {
            const attachment = createParsedAttachment('agent_file', label, attachments.length)
            if (attachment) attachments.push(attachment)
          }
        } else if (promptLine.startsWith('Global Files:')) {
          for (const label of parseAttachmentList(promptLine.slice('Global Files:'.length))) {
            const attachment = createParsedAttachment('global_file', label, attachments.length)
            if (attachment) attachments.push(attachment)
          }
        }
        lineIndex += 1
      }
      continue
    }

    visibleLines.push(line)
    lineIndex += 1
  }

  return {
    content: visibleLines.join('\n').trim(),
    attachments,
  }
}
