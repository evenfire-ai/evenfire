/**
 * Naming, placing and reporting the files the document generators write.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { ArtifactMetadata, InternalToolResult } from './types'

const MAX_STEM_LENGTH = 120

/**
 * Extensions a requested name may already carry. Anything else after a dot is
 * part of the name, so "report.v2" keeps its "v2".
 */
const KNOWN_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'htm',
  'html',
  'json',
])

/**
 * A safe filename for a generated artifact.
 *
 * Only ASCII letters, digits, '.', '_' and '-' are kept, because the download
 * paths do not all encode other characters. Dropping characters must not make
 * two requested names equal ("報告.md" and "資料.md" would both be "__.md"), so
 * when anything other than a space is replaced or dropped a short hash of the
 * requested name is appended. The stem is shortened before the extension is
 * added, so a long name keeps its extension.
 */
export function outputFilename(requested: unknown, ext: string, fallbackStem: string): string {
  const extension = ext.replace(/^\./, '').toLowerCase()
  const base = path.basename(String(requested ?? '').normalize('NFC')).trim()
  const dot = base.lastIndexOf('.')
  const stem =
    dot > 0 && KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) ? base.slice(0, dot) : base

  if (!stem) return `${fallbackStem}.${extension}`
  const safe = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
  if (safe === stem.replace(/\s+/g, '_') && safe && safe.length <= MAX_STEM_LENGTH) {
    return `${safe}.${extension}`
  }
  const hash = createHash('sha256').update(stem).digest('hex').slice(0, 8)
  return `${(safe || fallbackStem).slice(0, MAX_STEM_LENGTH - hash.length - 1)}-${hash}.${extension}`
}

export interface OutputTarget {
  filename: string
  filePath: string
  /** A file already at `filePath` will be overwritten. */
  replacesExisting: boolean
}

/** Where to write `filename`; a file already there is replaced. */
export function claimOutputFile(outputDir: string, filename: string): OutputTarget {
  const filePath = path.join(outputDir, filename)
  const entry = lstat(filePath)
  // A write follows a symbolic link, so a link in the name's place is removed
  // and a regular file is written there instead of wherever it points.
  if (entry?.isSymbolicLink()) fs.unlinkSync(filePath)
  return { filename, filePath, replacesExisting: !!entry && !entry.isSymbolicLink() }
}

function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch {
    return undefined
  }
}

/** Size of the file a write is about to replace, so a quota check does not count it twice. */
export function replacedBytes(target: OutputTarget): number {
  if (!target.replacesExisting) return 0
  try {
    return fs.statSync(target.filePath).size
  } catch {
    return 0
  }
}

/** Lines of notes a result carries; the rest are counted. */
const MAX_NOTES = 12

/** Notes of one kind shown before the rest of the kind is counted. */
const NOTES_PER_KIND = 3

/** A note about content the file does not hold, which comes first. */
const LOSS_NOTE =
  /\b(dropped|left out|could not|cannot|missing|not drawn|was cut|were cut|skipped)\b/i

/**
 * `warnings` in a length the agent can relay: past a few, notes that differ
 * only in their numbers (a row, a cell, a count) are counted, and notes about
 * lost content come first.
 */
export function capNotes(warnings: string[]): string[] {
  const groups = new Map<string, { notes: string[]; loss: boolean }>()
  for (const warning of new Set(warnings)) {
    const key = warning.replace(/\d+(?:\.\d+)?/g, '#')
    const group = groups.get(key)
    if (group) group.notes.push(warning)
    else groups.set(key, { notes: [warning], loss: LOSS_NOTE.test(warning) })
  }
  const lines = [...groups.values()]
    .sort((a, b) => Number(b.loss) - Number(a.loss))
    .flatMap(({ notes }) => {
      const shown = notes.slice(0, NOTES_PER_KIND)
      const more = notes.length - shown.length
      if (more > 0) shown[shown.length - 1] += ` (${more} more like it.)`
      return shown
    })
  if (lines.length <= MAX_NOTES) return lines
  return [...lines.slice(0, MAX_NOTES), `(${lines.length - MAX_NOTES} more notes of other kinds.)`]
}

/**
 * The result of a generator that wrote `target`. The message leads with the
 * name the file was actually saved under, which is what another generator must
 * be given to embed it, and carries any warnings so the agent can relay them.
 */
export function artifactResult(
  target: OutputTarget,
  format: ArtifactMetadata['format'],
  opts: { summary?: string; warnings?: string[] } = {}
): InternalToolResult {
  const stats = fs.statSync(target.filePath)
  const parts = [opts.summary ?? `File generated: ${target.filename} (${format}).`]
  const warnings = capNotes(opts.warnings ?? [])
  if (warnings.length > 0) parts.push(`Notes: ${warnings.join(' ')}`)
  return {
    success: true,
    artifact: {
      name: target.filename,
      format,
      path: target.filePath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    },
    content: parts.join('\n'),
  }
}
