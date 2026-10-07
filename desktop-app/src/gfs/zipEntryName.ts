/**
 * Shared, pure ZIP entry-name finalization (folder-zip export). Used by BOTH
 * the renderer walk (which finalizes names before sending them, so overlong
 * results are visible skips) and the main-process streaming writer (which
 * re-validates defensively before writing headers). Pure TS, no Electron/DOM:
 * safe to import from either bundle.
 */

/** A ZIP name field is a 16-bit byte count: names must stay strictly under it. */
export const MAX_ZIP_ENTRY_NAME_BYTES = 65535

export interface FinalizedEntryName {
  /** The name to commit (unchanged, or carrying a ` (n)` collision suffix). */
  name: string
  /** The case-folded key that owns the name in the caller's set. */
  folded: string
}

export const foldEntryName = (name: string): string => name.toLowerCase()

/**
 * Case-insensitive de-duplication for entry names (spec: name-collision
 * policy): portable case-insensitive extractors (macOS, Windows) would
 * silently overwrite `Report.txt` with `report.txt`, so a colliding name gets
 * the ` (2)`, ` (3)`, ... suffix on its final segment. The caller registers
 * `finalized.folded` in its used set.
 */
export function finalizeEntryName(
  candidate: string,
  usedFoldedNames: ReadonlySet<string>
): FinalizedEntryName {
  const fold = foldEntryName(candidate)
  if (!usedFoldedNames.has(fold)) return { name: candidate, folded: fold }
  const slash = candidate.lastIndexOf('/')
  const directory = slash >= 0 ? candidate.slice(0, slash + 1) : ''
  const base = slash >= 0 ? candidate.slice(slash + 1) : candidate
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const extension = dot > 0 ? base.slice(dot) : ''
  let counter = 2
  let name = `${directory}${stem} (${counter})${extension}`
  let folded = foldEntryName(name)
  while (usedFoldedNames.has(folded)) {
    counter += 1
    name = `${directory}${stem} (${counter})${extension}`
    folded = foldEntryName(name)
  }
  return { name, folded }
}

/**
 * True when the FINALIZED name's UTF-8 encoding fits the 16-bit ZIP name
 * fields. Runs on the post-suffix name (R1-M2): a near-limit name whose
 * collision suffix pushes it past the bound must be rejected here, not
 * truncated by the writer.
 */
export function entryNameFitsZipFields(name: string): boolean {
  let bytes = 0
  for (const character of name) {
    if (character.charCodeAt(0) < 0x80) bytes += 1
    else if (character.charCodeAt(0) < 0x800) bytes += 2
    else bytes += character.codePointAt(0)! > 0xffff ? 4 : 3
  }
  return bytes > 0 && bytes < MAX_ZIP_ENTRY_NAME_BYTES
}
