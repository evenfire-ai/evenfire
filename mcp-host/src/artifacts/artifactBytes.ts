import * as fs from 'fs'
import {
  ArtifactPathError,
  MAX_ARTIFACT_BYTES,
  type OpenedArtifactFile,
} from '../workflow/artifactPaths'
import { type ArtifactSecretEntry, redactArtifactBuffer } from './artifactRedaction'

export type ArtifactRedactionState = 'applied' | 'scanned' | 'skipped:binary'

const BINARY_ARTIFACT_FORMATS = new Set([
  'doc',
  'docx',
  'gif',
  'jpg',
  'jpeg',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'zip',
])

export function readOpenedArtifactBuffer(
  artifact: OpenedArtifactFile,
  maxBytes = MAX_ARTIFACT_BYTES
): Buffer {
  const effectiveMaxBytes = Math.min(maxBytes, MAX_ARTIFACT_BYTES)
  const expectedBytes = artifact.stat.size
  if (expectedBytes > effectiveMaxBytes) {
    throw new ArtifactPathError(413, 'Artifact too large to download')
  }

  const buffer = Buffer.alloc(expectedBytes)
  let offset = 0
  while (offset < expectedBytes) {
    const bytesRead = fs.readSync(artifact.fd, buffer, offset, expectedBytes - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }

  const latestStat = fs.fstatSync(artifact.fd)
  if (latestStat.size > effectiveMaxBytes) {
    throw new ArtifactPathError(413, 'Artifact too large to download')
  }
  if (latestStat.size !== expectedBytes || offset !== expectedBytes) {
    throw new ArtifactPathError(500, 'Artifact changed during download')
  }

  return buffer
}

export function isBinaryArtifactFormat(format: string): boolean {
  return BINARY_ARTIFACT_FORMATS.has(format.replace(/^\./, '').toLowerCase())
}

export function redactArtifactForDelivery(
  format: string,
  buffer: Buffer,
  entries: ArtifactSecretEntry[]
): { buffer: Buffer; redactedCount: number; redactionState: ArtifactRedactionState } {
  if (isBinaryArtifactFormat(format)) {
    return { buffer, redactedCount: 0, redactionState: 'skipped:binary' }
  }
  const redacted = redactArtifactBuffer(buffer, entries)
  return {
    ...redacted,
    redactionState: redacted.redactedCount > 0 ? 'applied' : 'scanned',
  }
}

export function redactionHeaderValue(
  format: string,
  redactedCount: number
): ArtifactRedactionState {
  if (redactedCount > 0) return 'applied'
  return isBinaryArtifactFormat(format) ? 'skipped:binary' : 'scanned'
}
