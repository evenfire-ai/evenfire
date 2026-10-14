import { createHash } from 'crypto'
import * as fs from 'fs'
import {
  isBinaryArtifactFormat,
  readOpenedArtifactBuffer,
  redactArtifactForDelivery,
} from '../../artifacts/artifactBytes'
import type { ArtifactSecretEntry } from '../../artifacts/artifactRedaction'
import { OFFICE_PACKAGE_LIMITS, officePackageHasText } from '../../artifacts/officePackageText'
import { withoutSeparators } from '../../artifacts/shownNumbers'
import { logger } from '../../logger'
import {
  ArtifactPathError,
  isSafeArtifactFilename,
  openExistingArtifactFile,
} from '../../workflow/artifactPaths'
import { printedForms } from '../../workflow/toolText'
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

/** Zip packages of XML parts, whose delivered text can be read back. */
const OFFICE_PACKAGE_FORMATS: ReadonlySet<InternalGeneratedArtifactFormat> = new Set([
  'docx',
  'xlsx',
  'pptx',
])

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
  /**
   * Texts every package of this format holds on its own (officeBoilerplate).
   * A protected value found in them is left to the payload check, since the
   * package scan cannot tell it from the generator's own text.
   */
  packageBoilerplate?: readonly string[]
  /**
   * What the file shows that its arguments do not spell (a chart's drawn
   * labels), each string as drawn; compared without separators.
   */
  shownText?: readonly string[]
  /**
   * The SHA-256 of the bytes the generator wrote. Other bytes found under the
   * name (another call wrote it since) are not delivered.
   */
  writtenSha256?: string
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
  logger.warn(
    {
      component: 'GeneratedArtifactAttachment',
      reason,
      tool: sourceTool,
      format: artifact.format,
      filename: artifact.name,
    },
    'Skipping artifact attachment'
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

/**
 * Whether a string the file shows holds an entry, both without separators: a
 * label drawn "3,141,592,653" shows "3141592653" and "3.141.592.653" alike.
 */
function shownTextHoldsSecretEntry(
  shown: readonly string[] | undefined,
  entries: ArtifactSecretEntry[]
): boolean {
  if (!shown?.length) return false
  const values = entries
    .map(entry => withoutSeparators(entry.value))
    .filter(value => value.length >= 4)
  if (values.length === 0) return false
  return shown.some(text => {
    const bare = withoutSeparators(text)
    return values.some(value => bare.includes(value))
  })
}

/**
 * Every string, number and key in `value` as written. A serialized form
 * escapes quotes and backslashes, so a secret holding either would not match it.
 */
function payloadTexts(value: unknown, out: string[], seen: Set<object>, depth: number): void {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number' || typeof value === 'bigint') out.push(String(value))
  else if (value && typeof value === 'object' && depth <= 64 && !seen.has(value)) {
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) payloadTexts(item, out, seen, depth + 1)
    } else {
      for (const [key, item] of Object.entries(value)) {
        out.push(key)
        payloadTexts(item, out, seen, depth + 1)
      }
    }
  }
}

function sourcePayloadContainsRedactableSecretEntry(
  sourcePayload: unknown,
  entries: ArtifactSecretEntry[]
): boolean {
  return payloadSecretEntries(sourcePayload, entries).length > 0
}

/** The entries `sourcePayload` holds anywhere in its strings, numbers and keys. */
function payloadSecretEntries(
  sourcePayload: unknown,
  entries: ArtifactSecretEntry[]
): ArtifactSecretEntry[] {
  if (sourcePayload === undefined || entries.length === 0) return []
  const texts: string[] = []
  payloadTexts(sourcePayload, texts, new Set(), 0)
  return entries.filter(entry =>
    texts.some(text => textContainsRedactableSecretEntry(text, [entry]))
  )
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
    if (
      params.writtenSha256 !== undefined &&
      createHash('sha256').update(fileBuffer).digest('hex') !== params.writtenSha256
    ) {
      warnSkip('artifact_replaced_before_delivery', params.sourceTool, params.artifact)
      return null
    }
    const secretEntries = params.secretEntriesProvider?.() ?? []
    if (shownTextHoldsSecretEntry(params.shownText, secretEntries)) {
      warnSkip('binary_redaction_unavailable', params.sourceTool, params.artifact)
      return null
    }
    if (isBinaryArtifactFormat(expectedFormat)) {
      // Binary artifacts are not redacted byte-by-byte here, so one that may
      // hold a secret is withheld: when the source payload that produced it
      // holds one, and, for an Office package, when the text it delivers does.
      if (secretEntries.length > 0 && params.sourcePayload === undefined) {
        warnSkip('binary_source_payload_unavailable', params.sourceTool, params.artifact)
        return null
      }
      if (sourcePayloadContainsRedactableSecretEntry(params.sourcePayload, secretEntries)) {
        warnSkip('binary_redaction_unavailable', params.sourceTool, params.artifact)
        return null
      }
      // A generator can write a value in a form the payload never spelled, as
      // a sheet stores the text "3,141,592,653" as the number 3141592653, so
      // the package is read as delivered. One that cannot be read is withheld.
      const boilerplate = params.packageBoilerplate ?? []
      const packageEntries = secretEntries.filter(
        entry => !boilerplate.some(text => text.includes(entry.value))
      )
      // Numbers are compared as shown without separators, so any locale's
      // grouping of a protected value matches. Every entry counts here: a
      // number a cell or a chart shows comes from the arguments, never from
      // the generator's own text.
      const shownValues = secretEntries
        .map(entry => withoutSeparators(entry.value))
        .filter(value => value.length >= 4)
      if (
        (packageEntries.length > 0 || shownValues.length > 0) &&
        OFFICE_PACKAGE_FORMATS.has(expectedFormat)
      ) {
        const found = officePackageHasText(
          fileBuffer,
          text => textContainsRedactableSecretEntry(text, packageEntries),
          OFFICE_PACKAGE_LIMITS,
          shownValues.length > 0 ? shown => shownValues.some(value => shown.includes(value)) : null
        )
        if (found !== false) {
          warnSkip(
            found ? 'binary_redaction_unavailable' : 'office_package_unreadable',
            params.sourceTool,
            params.artifact
          )
          return null
        }
      }
    }
    // A text file is redacted byte by byte, which misses a protected value its
    // markup splits ("probe-**redaction**-value") and a preview shows joined:
    // such a file is withheld. The printed forms of the arguments carry it whole.
    if (!isBinaryArtifactFormat(expectedFormat) && secretEntries.length > 0) {
      const text = fileBuffer.toString('utf8')
      const split = payloadSecretEntries(params.sourcePayload, secretEntries).filter(
        entry => !text.includes(entry.value)
      )
      if (split.length > 0) {
        warnSkip('text_redaction_unavailable', params.sourceTool, params.artifact)
        return null
      }
    }
    const redacted = redactArtifactForDelivery(expectedFormat, fileBuffer, secretEntries)
    // A value printed whole once is redacted, but the same value split by
    // markup elsewhere in the file is not: read the redacted text as printed.
    if (
      !isBinaryArtifactFormat(expectedFormat) &&
      secretEntries.length > 0 &&
      printedForms(redacted.buffer.toString('utf8')).some(text =>
        textContainsRedactableSecretEntry(text, secretEntries)
      )
    ) {
      warnSkip('text_redaction_unavailable', params.sourceTool, params.artifact)
      return null
    }
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
