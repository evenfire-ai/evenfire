import * as fs from 'fs'
import {
  isBinaryArtifactFormat,
  readOpenedArtifactBuffer,
  redactArtifactForDelivery,
} from '../../artifacts/artifactBytes'
import type { ArtifactSecretEntry } from '../../artifacts/artifactRedaction'
import {
  ArtifactPathError,
  isSafeArtifactFilename,
  openExistingArtifactFile,
} from '../../workflow/artifactPaths'
import type { ArtifactMetadata } from '../../workflow/types'
import type { Attachment } from '../types'

export const INTERNAL_GENERATED_ARTIFACT_LANE = 'internal_generated_artifact' as const
export const INTERNAL_GENERATED_ARTIFACT_PRODUCER = 'mcp-host-internal-tool' as const

export type InternalGeneratedArtifactFormat = 'md' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'png'

export const INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL: ReadonlyMap<
  string,
  InternalGeneratedArtifactFormat
> = new Map([
  ['clerum__generate_markdown', 'md'],
  ['clerum__generate_pdf', 'pdf'],
  ['clerum__generate_docx', 'docx'],
  ['clerum__generate_xlsx', 'xlsx'],
  ['clerum__generate_pptx', 'pptx'],
  ['clerum__generate_chart', 'png'],
] as const)

export const INTERNAL_GENERATED_ARTIFACT_MIME_BY_FORMAT: ReadonlyMap<
  InternalGeneratedArtifactFormat,
  string
> = new Map([
  ['md', 'text/markdown'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['png', 'image/png'],
] as const)

type BuildGeneratedArtifactAttachmentParams = {
  sourceTool: string
  artifact: ArtifactMetadata
  outputDir: string
  maxBytes: number
  sourcePayload?: unknown
  secretEntriesProvider?: () => ArtifactSecretEntry[]
}

function extension(filename: string | undefined): string {
  if (!filename) return ''
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : ''
}

function safeAttachmentId(toolName: string, filename: string): string {
  return `internal-generated-${toolName}-${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
}

function normalizeInternalGeneratedArtifactFormat(
  format: string | undefined
): InternalGeneratedArtifactFormat | undefined {
  const lowered = (format || '').toLowerCase()
  switch (lowered) {
    case 'md':
    case 'pdf':
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'png':
      return lowered as InternalGeneratedArtifactFormat
    default:
      return undefined
  }
}

function closeFd(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore close failure after read outcome is known */
  }
}

function warnSkip(reason: string, sourceTool: string, artifact: ArtifactMetadata): void {
  console.warn(
    `[GeneratedArtifactAttachment] Skipping artifact attachment: reason=${reason}, ` +
      `tool=${sourceTool}, format=${artifact.format}, filename=${artifact.name}`
  )
}

function textContainsRedactableSecretEntry(
  content: string,
  entries: ArtifactSecretEntry[]
): boolean {
  if (entries.length === 0) return false
  return entries.some(entry => {
    if (!entry.value || entry.value.length < 4) return false
    return content.includes(entry.value)
  })
}

function sourcePayloadContainsRedactableSecretEntry(
  sourcePayload: unknown,
  entries: ArtifactSecretEntry[]
): boolean {
  if (sourcePayload === undefined || entries.length === 0) return false
  try {
    const serialized = JSON.stringify(sourcePayload)
    return textContainsRedactableSecretEntry(serialized ?? '', entries)
  } catch {
    return textContainsRedactableSecretEntry(String(sourcePayload), entries)
  }
}

export function isInternalGeneratedArtifactSourceTool(sourceTool: string | undefined): boolean {
  return Boolean(sourceTool && INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL.has(sourceTool))
}

export function expectedInternalGeneratedArtifactFormat(
  sourceTool: string | undefined
): InternalGeneratedArtifactFormat | undefined {
  if (!sourceTool) return undefined
  return INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL.get(sourceTool)
}

export function expectedInternalGeneratedArtifactMime(
  format: string | undefined
): string | undefined {
  const normalized = normalizeInternalGeneratedArtifactFormat(format)
  if (!normalized) return undefined
  return INTERNAL_GENERATED_ARTIFACT_MIME_BY_FORMAT.get(normalized)
}

export function isInternalGeneratedArtifactAttachment(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.lane !== INTERNAL_GENERATED_ARTIFACT_LANE) return false
  if (attachment.producer !== INTERNAL_GENERATED_ARTIFACT_PRODUCER) return false
  const expectedFormat = expectedInternalGeneratedArtifactFormat(attachment.sourceTool)
  if (!expectedFormat) return false
  if (attachment.artifactFormat !== expectedFormat) return false
  if (extension(attachment.filename) !== expectedFormat) return false
  const expectedMime = expectedInternalGeneratedArtifactMime(expectedFormat)
  if (!expectedMime) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expectedMime
}

export function buildGeneratedArtifactAttachment(
  params: BuildGeneratedArtifactAttachmentParams
): Attachment | null {
  const expectedFormat = expectedInternalGeneratedArtifactFormat(params.sourceTool)
  if (!expectedFormat) {
    warnSkip('source_tool_not_allowed', params.sourceTool, params.artifact)
    return null
  }

  if (params.artifact.format !== expectedFormat) {
    warnSkip('format_does_not_match_source_tool', params.sourceTool, params.artifact)
    return null
  }

  if (!isSafeArtifactFilename(params.artifact.name)) {
    warnSkip('unsafe_filename', params.sourceTool, params.artifact)
    return null
  }

  if (extension(params.artifact.name) !== expectedFormat) {
    warnSkip('extension_does_not_match_format', params.sourceTool, params.artifact)
    return null
  }

  const mimeType = expectedInternalGeneratedArtifactMime(expectedFormat)
  if (!mimeType) {
    warnSkip('mime_not_allowed', params.sourceTool, params.artifact)
    return null
  }

  let opened
  try {
    opened = openExistingArtifactFile(params.outputDir, params.artifact.name)
    const fileBuffer = readOpenedArtifactBuffer(opened, params.maxBytes)
    const secretEntries = params.secretEntriesProvider?.() ?? []
    if (isBinaryArtifactFormat(expectedFormat)) {
      // Binary artifacts are not redacted byte-by-byte here. Trust is limited to
      // native generator provenance plus the source payload that produced them.
      if (secretEntries.length > 0 && params.sourcePayload === undefined) {
        warnSkip('binary_source_payload_unavailable', params.sourceTool, params.artifact)
        return null
      }
      if (sourcePayloadContainsRedactableSecretEntry(params.sourcePayload, secretEntries)) {
        warnSkip('binary_redaction_unavailable', params.sourceTool, params.artifact)
        return null
      }
    }
    const redacted = redactArtifactForDelivery(expectedFormat, fileBuffer, secretEntries)
    if (redacted.buffer.byteLength > params.maxBytes) {
      warnSkip('redacted_artifact_too_large', params.sourceTool, params.artifact)
      return null
    }

    return {
      id: safeAttachmentId(params.sourceTool, params.artifact.name),
      kind: 'file',
      mimeType,
      encoding: 'base64',
      dataBase64: redacted.buffer.toString(('base' + '64') as BufferEncoding),
      filename: params.artifact.name,
      caption: `Generated artifact: ${params.artifact.name} (${redacted.buffer.byteLength} bytes)`,
      sourceTool: params.sourceTool,
      lane: INTERNAL_GENERATED_ARTIFACT_LANE,
      artifactFormat: expectedFormat,
      sizeBytes: redacted.buffer.byteLength,
      redactionState: redacted.redactionState,
      producer: INTERNAL_GENERATED_ARTIFACT_PRODUCER,
    }
  } catch (err) {
    const reason =
      err instanceof ArtifactPathError ? `artifact_path_error_${err.status}` : 'artifact_read_error'
    warnSkip(reason, params.sourceTool, params.artifact)
    return null
  } finally {
    if (opened) closeFd(opened.fd)
  }
}
