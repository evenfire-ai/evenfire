/**
 * TASK-42 — resend draft builder.
 *
 * Turns a sent USER message back into composer input: the visible text for the
 * draft, inline image bytes re-attached as composer image attachments, and
 * plugin/connector/agent-file/global-file indicators re-applied as composer
 * references.
 *
 * Fidelity ladder (a message can carry its inputs in two places):
 *  1. The raw content's `USER-ATTACHED CONTEXT:` block (server-authoritative
 *     messages) — carries full identity (plugin `ns/name`, agent-file
 *     `filesystem/path`, global-file `label (gfs://drive/resourceId)`).
 *  2. The persisted `attachments` chips (locally optimistic messages) —
 *     uploaded files carry their base64 bytes, references carry labels only.
 *     Labels that still encode the identity (`ns/name`) are split back into
 *     structured fields; bare labels become best-effort references so the
 *     indicator chip still re-appears (re-selecting from the + menu restores
 *     the exact prompt coverage).
 *
 * `response_file` attachments are never re-applied: they are artifacts the
 * previous reply generated, not inputs of the resent prompt.
 */
import type { ChatMessageAttachment } from '../../../src/types'
import type {
  AgentChatMessage,
  ComposerImageAttachment,
  ComposerReferenceAttachment,
} from '../uiTypes'
import { parseChatMessageDisplay } from './chatMessageAttachments'

export type ComposerResendDraft = {
  /** Visible text for the composer draft (context block stripped). */
  content: string
  imageAttachments: ComposerImageAttachment[]
  referenceAttachments: ComposerReferenceAttachment[]
  /** Chips that could not be rebuilt (e.g. legacy label-only uploaded files). */
  unrestorable: Array<{ type: ChatMessageAttachment['type']; label: string }>
}

type StructuredPlugin = { namespace: string; name: string }
type StructuredConnector = { name: string }
type StructuredAgentFile = { filesystemName: string; path: string }
type StructuredGlobalFile = {
  label: string
  drive: string
  resourceId: string
  gfsUri: string
}

type StructuredReferences = {
  plugin: StructuredPlugin[]
  connector: StructuredConnector[]
  agentFile: StructuredAgentFile[]
  globalFile: StructuredGlobalFile[]
}

const USER_ATTACHED_CONTEXT_MARKER = 'USER-ATTACHED CONTEXT:'

/** Mirrors the legacy list format: first sentence, comma-separated items. */
function splitAttachmentItems(value: string): string[] {
  const segment = (value.split(/\.\s+/)[0] ?? '').replace(/\.\s*$/, '')
  return segment
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseStructuredGlobalFile(item: string): StructuredGlobalFile {
  const labeled = item.match(/^(.*?)\s+\((gfs:\/\/[^)]+)\)$/i)
  if (labeled?.[1] && labeled[2]) {
    return parseGlobalFileFromUri(labeled[1].trim(), labeled[2])
  }
  if (/^gfs:\/\/[^/]+\//i.test(item)) {
    return parseGlobalFileFromUri('', item)
  }
  return { label: item, drive: '', resourceId: '', gfsUri: '' }
}

function parseGlobalFileFromUri(label: string, gfsUri: string): StructuredGlobalFile {
  const uri = gfsUri.match(/^gfs:\/\/([^/]+)\/(.+)$/i)
  if (!uri?.[1] || uri[2] === undefined) {
    return { label, drive: '', resourceId: '', gfsUri }
  }
  return { label, drive: uri[1], resourceId: uri[2], gfsUri }
}

function pathBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Extracts full-identity references from the `USER-ATTACHED CONTEXT:` block a
 * sent message embeds (the same block `parseChatMessageDisplay` strips for
 * display). Only this source carries plugin namespaces, agent-file filesystem
 * paths, and global-file URIs.
 */
export function parseStructuredResendReferences(content: string): StructuredReferences {
  const result: StructuredReferences = { plugin: [], connector: [], agentFile: [], globalFile: [] }
  const lines = content.split('\n')
  let markerIndex = lines.findIndex(line => line.trim().startsWith(USER_ATTACHED_CONTEXT_MARKER))
  if (markerIndex === -1) return result
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (line.startsWith('Plugins:')) {
      for (const item of splitAttachmentItems(line.slice('Plugins:'.length))) {
        const qualified = item.match(/^([^/\s]+)\/([^/\s]+)$/)
        result.plugin.push(
          qualified?.[1] && qualified[2]
            ? { namespace: qualified[1], name: qualified[2] }
            : { namespace: '', name: item }
        )
      }
    } else if (line.startsWith('Connectors:')) {
      for (const item of splitAttachmentItems(line.slice('Connectors:'.length))) {
        result.connector.push({ name: item })
      }
    } else if (line.startsWith('Agent Files:')) {
      for (const item of splitAttachmentItems(line.slice('Agent Files:'.length))) {
        const slash = item.indexOf('/')
        result.agentFile.push(
          slash > 0
            ? { filesystemName: item.slice(0, slash), path: item.slice(slash + 1) }
            : { filesystemName: '', path: item }
        )
      }
    } else if (line.startsWith('Global Files:')) {
      for (const item of splitAttachmentItems(line.slice('Global Files:'.length))) {
        result.globalFile.push(parseStructuredGlobalFile(item))
      }
    }
  }
  return result
}

function buildResendImageAttachment(
  chip: ChatMessageAttachment,
  index: number
): ComposerImageAttachment | null {
  if (chip.type !== 'uploaded_file') return null
  if (chip.encoding !== 'base64') return null
  const dataBase64 = typeof chip.dataBase64 === 'string' ? chip.dataBase64 : ''
  if (!dataBase64) return null
  const mimeType =
    chip.mimeType === 'image/jpeg' || chip.mimeType === 'image/png' ? chip.mimeType : null
  if (!mimeType) return null
  return {
    id: `resend-image:${chip.id}:${index}`,
    ...(chip.addedOrder !== undefined ? { addedOrder: chip.addedOrder } : {}),
    name: chip.filename || chip.label,
    mimeType,
    dataBase64,
    sizeBytes: chip.sizeBytes ?? Math.floor((dataBase64.length * 3) / 4),
    previewDataUrl: `data:${mimeType};base64,${dataBase64}`,
  }
}

function buildPluginReference(
  label: string,
  structured: StructuredPlugin[]
): Extract<ComposerReferenceAttachment, { type: 'plugin' }> {
  const match =
    structured.find(entry => entry.namespace && `${entry.namespace}/${entry.name}` === label) ??
    structured.find(entry => entry.namespace && entry.name === label) ??
    null
  if (match) {
    return {
      id: `plugin:${match.namespace}:${match.name}`,
      type: 'plugin',
      namespace: match.namespace,
      name: match.name,
      label: match.name,
    }
  }
  const qualified = label.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (qualified?.[1] && qualified[2]) {
    return {
      id: `plugin:${qualified[1]}:${qualified[2]}`,
      type: 'plugin',
      namespace: qualified[1],
      name: qualified[2],
      label: qualified[2],
    }
  }
  return { id: `plugin:resend:${label}`, type: 'plugin', namespace: '', name: label, label }
}

function buildConnectorReference(
  label: string,
  structured: StructuredConnector[]
): Extract<ComposerReferenceAttachment, { type: 'connector' }> {
  const name = structured.find(entry => entry.name === label)?.name ?? label
  return { id: `connector:${name}`, type: 'connector', name, label: name }
}

function buildAgentFileReference(
  label: string,
  structured: StructuredAgentFile[]
): Extract<ComposerReferenceAttachment, { type: 'agent_file' }> {
  const match =
    structured.find(
      entry =>
        entry.filesystemName &&
        `${entry.filesystemName}/${entry.path.replace(/^\/+/, '')}` === label
    ) ??
    structured.find(entry => entry.filesystemName && pathBasename(entry.path) === label) ??
    null
  if (match) {
    const normalizedPath = match.path.replace(/^\/+|\/+$/g, '')
    return {
      id: `agent-file:resend:${match.filesystemName}:${normalizedPath}`,
      type: 'agent_file',
      contextId: '',
      filesystemName: match.filesystemName,
      path: normalizedPath,
      kind: normalizedPath ? 'file' : 'directory',
      label: pathBasename(normalizedPath) || match.filesystemName,
    }
  }
  const normalizedLabel = label.replace(/^\/+|\/+$/g, '')
  return {
    id: `agent-file:resend:${normalizedLabel}`,
    type: 'agent_file',
    contextId: '',
    filesystemName: '',
    path: normalizedLabel,
    kind: 'file',
    label: pathBasename(normalizedLabel),
  }
}

function buildGlobalFileReference(
  label: string,
  structured: StructuredGlobalFile[]
): Extract<ComposerReferenceAttachment, { type: 'global_file' }> {
  const match =
    structured.find(entry => entry.gfsUri && entry.label === label) ??
    structured.find(entry => entry.gfsUri && pathBasename(entry.gfsUri) === label) ??
    null
  if (match) {
    return {
      id: `global-file:resend:${match.gfsUri}`,
      type: 'global_file',
      resourceId: match.resourceId,
      drive: match.drive,
      gfsUri: match.gfsUri,
      label: match.label || pathBasename(match.gfsUri),
    }
  }
  return {
    id: `global-file:resend:${label}`,
    type: 'global_file',
    resourceId: '',
    drive: '',
    gfsUri: '',
    label,
  }
}

/**
 * Builds the composer repopulation payload for a sent user message. Chip
 * resolution mirrors the thread's display precedence: the persisted
 * `attachments` array wins when present, otherwise the chips parsed from the
 * legacy/`USER-ATTACHED CONTEXT` content markers.
 */
export function buildComposerResendDraft(
  message: Pick<AgentChatMessage, 'content' | 'attachments'>
): ComposerResendDraft {
  const parsed = parseChatMessageDisplay(message.content)
  const chips = message.attachments?.length ? message.attachments : parsed.attachments
  const structured = parseStructuredResendReferences(message.content)
  const imageAttachments: ComposerImageAttachment[] = []
  const referenceAttachments: ComposerReferenceAttachment[] = []
  const unrestorable: ComposerResendDraft['unrestorable'] = []

  for (const [index, chip] of chips.entries()) {
    if (chip.type === 'uploaded_file') {
      const image = buildResendImageAttachment(chip, index)
      if (image) {
        imageAttachments.push(image)
      } else {
        unrestorable.push({ type: chip.type, label: chip.label })
      }
      continue
    }
    if (chip.type === 'response_file') continue
    if (chip.type === 'plugin') {
      referenceAttachments.push(buildPluginReference(chip.label, structured.plugin))
      continue
    }
    if (chip.type === 'connector') {
      referenceAttachments.push(buildConnectorReference(chip.label, structured.connector))
      continue
    }
    if (chip.type === 'agent_file') {
      referenceAttachments.push(buildAgentFileReference(chip.label, structured.agentFile))
      continue
    }
    if (chip.type === 'global_file') {
      referenceAttachments.push(buildGlobalFileReference(chip.label, structured.globalFile))
    }
  }

  return { content: parsed.content, imageAttachments, referenceAttachments, unrestorable }
}

/**
 * TASK-42 resend rule for ASSISTANT messages: "resending" a reply re-issues the
 * prompt that produced it. Walks the rendered groups backwards from `groupIndex`
 * to the nearest user group and returns its LAST message (the turn trigger);
 * `null` when the reply has no preceding user message to re-issue.
 */
export function findNearestPrecedingUserMessage<
  T extends Pick<AgentChatMessage, 'role' | 'content' | 'attachments'>,
>(
  groups: Array<{ role: 'user' | 'assistant' | 'system'; items: T[] }>,
  groupIndex: number
): T | null {
  for (let index = groupIndex - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (!group || group.role !== 'user') continue
    return group.items.at(-1) ?? null
  }
  return null
}
