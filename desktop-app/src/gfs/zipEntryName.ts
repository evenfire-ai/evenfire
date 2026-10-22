/**
 * Shared, pure ZIP entry-name allocation (folder-zip export). Used by BOTH the
 * renderer walk (which allocates names before sending them, so overlong results
 * are visible skips) and the main-process streaming writer (which re-allocates
 * defensively before writing headers). Pure TS, no Electron/DOM: safe to import
 * from either bundle.
 *
 * The allocation is PATH-AWARE, not name-aware. A ZIP entry name is a path,
 * and every extractor materializes each path component as a real directory.
 * A file named `report` and a directory `Report/` therefore collide on a
 * case-insensitive filesystem (macOS, Windows) even though their full names
 * differ — full-name de-duplication alone silently lets one overwrite the
 * other. The allocator reserves case-folded path PREFIXES next to complete
 * names (R3-M5), and resolves the file/directory conflict deterministically.
 */
import { MAX_ZIP_ENTRY_NAME_BYTES } from './zipLimits.js'

/** A ZIP name field is a 16-bit byte count: names must stay strictly under it. */
export { MAX_ZIP_ENTRY_NAME_BYTES }

export interface FinalizedEntryName {
  /** The name to commit (unchanged, or carrying a ` (n)` collision suffix). */
  name: string
  /** The case-folded key that owns the name in the caller's set. */
  folded: string
}

export const foldEntryName = (name: string): string => name.toLowerCase()

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

/**
 * Splits a base name into stem and extension for ` (n)` suffixing. A LEADING
 * dot is a dotfile, not an extension: `.env` has no extension, so it becomes
 * `.env (2)` rather than `. (2)env`.
 */
function splitBaseName(base: string): { stem: string; extension: string } {
  const dot = base.lastIndexOf('.')
  return dot > 0
    ? { stem: base.slice(0, dot), extension: base.slice(dot) }
    : { stem: base, extension: '' }
}

/** `report.txt` + 2 -> `report (2).txt`. */
function suffixBaseName(base: string, counter: number): string {
  const { stem, extension } = splitBaseName(base)
  return `${stem} (${counter})${extension}`
}

/**
 * `Report` + 2 -> `Report (2)`. A DIRECTORY keeps its whole name: `Report.Data`
 * is a folder called "Report.Data", and `Report (2).Data` would read like a
 * file with an extension.
 */
function suffixDirectoryName(segment: string, counter: number): string {
  return `${segment} (${counter})`
}

/**
 * A name the allocator WOULD commit, computed without reserving anything.
 *
 * The two-phase shape (plan, then commit) is what lets a caller reject an
 * entry — an unusable name, an over-budget entry — without leaving the
 * allocator's reservations behind. A rejected append must leave the job's
 * state exactly as it was (R3-M2).
 */
export interface PlannedEntryName extends FinalizedEntryName {
  /**
   * False when no committed name could carry this entry: the name does not
   * fit the 16-bit ZIP name fields. Such a plan claims nothing.
   */
  fits: boolean
  /** The directory prefixes this plan would claim, as folded -> written. */
  directories: Array<[string, string]>
}

/**
 * Allocates collision-free ZIP entry names for ONE archive.
 *
 * Two namespaces are reserved, and they are mutually exclusive by
 * construction:
 *
 * - complete entry names (`fileNames`) — the full path of every committed file;
 * - directory prefixes (`directories`) — the path of every directory the
 *   committed files imply, mapped to the path actually written.
 *
 * A path may be reserved as a file OR as a directory, never both: allocating a
 * file whose folded path is already a directory renames the FILE, and
 * allocating a directory whose folded path is already a file renames the
 * DIRECTORY segment. That keeps every archive valid on a case-insensitive
 * extractor, in either insertion order.
 */
export class ZipEntryNameAllocator {
  /** Folded full path of every committed file. */
  private readonly fileNames = new Set<string>()
  /** Folded directory prefix -> the directory path actually written. */
  private readonly directories = new Map<string, string>()

  /**
   * Allocates the name to commit for `candidate` and RESERVES it. The returned
   * name differs from the candidate only where a collision forced it.
   */
  allocate(candidate: string): FinalizedEntryName {
    const plan = this.plan(candidate)
    this.commit(plan)
    return { name: plan.name, folded: plan.folded }
  }

  /**
   * Reserves a DIRECTORY path the archive will imply, without claiming a file
   * name for it.
   *
   * Reserving the directories first makes the file/directory resolution
   * independent of the order the entries arrive in: a file whose path would
   * collide with a directory is always the one that gets renamed, whichever
   * order the walk discovered them (R3-M5).
   */
  reserveDirectory(path: string): void {
    const segments = path.split('/')
    const resolved = this.resolveDirectoryPath(segments, new Map())
    for (const [folded, actual] of resolved.claimed) this.directories.set(folded, actual)
  }

  /**
   * Computes the name `candidate` would receive WITHOUT reserving it. The
   * caller commits the plan only once it has accepted the entry.
   */
  plan(candidate: string): PlannedEntryName {
    const segments = candidate.split('/')
    const fileSegment = segments.pop() ?? ''
    const { directoryPath, claimed } = this.resolveDirectoryPath(segments, new Map())

    const fullPath = directoryPath === '' ? fileSegment : `${directoryPath}/${fileSegment}`
    let name = fullPath
    let counter = 1
    while (this.isTaken(foldEntryName(name), claimed)) {
      counter += 1
      name = this.suffixPath(fullPath, counter)
    }
    const fits = entryNameFitsZipFields(name)
    return {
      name,
      folded: foldEntryName(name),
      fits,
      directories: fits ? [...claimed.entries()] : [],
    }
  }

  /**
   * Resolves the directory path a file's segments imply, and the directory
   * prefixes that resolution would claim.
   */
  private resolveDirectoryPath(
    segments: string[],
    claimed: Map<string, string>
  ): { directoryPath: string; claimed: Map<string, string> } {
    let directoryPath = ''
    for (const segment of segments) {
      directoryPath = directoryPath === '' ? segment : `${directoryPath}/${segment}`
      const foldedPrefix = foldEntryName(directoryPath)
      const known = this.directories.get(foldedPrefix) ?? claimed.get(foldedPrefix)
      if (known !== undefined) {
        // The directory was already written under another source directory:
        // reuse the committed path so every file below it stays together.
        directoryPath = known
        continue
      }
      // The prefix is free unless a FILE already owns that exact path: on a
      // case-insensitive extractor a file and a directory cannot share it.
      const resolved = this.fileNames.has(foldedPrefix)
        ? this.allocateDirectorySegment(directoryPath, segment, claimed)
        : directoryPath
      claimed.set(foldEntryName(resolved), resolved)
      directoryPath = resolved
    }
    return { directoryPath, claimed }
  }

  /** Reserves a planned name. A plan that does not fit claims nothing. */
  commit(plan: PlannedEntryName): void {
    if (!plan.fits) return
    for (const [folded, path] of plan.directories) this.directories.set(folded, path)
    this.fileNames.add(plan.folded)
  }

  /** True when the folded path is already owned by a file OR by a directory. */
  private isTaken(folded: string, claimed: ReadonlyMap<string, string>): boolean {
    return this.fileNames.has(folded) || this.directories.has(folded) || claimed.has(folded)
  }

  /** `a/b.txt` + 2 -> `a/b (2).txt`. */
  private suffixPath(fullPath: string, counter: number): string {
    const slash = fullPath.lastIndexOf('/')
    const directory = slash >= 0 ? fullPath.slice(0, slash + 1) : ''
    const base = slash >= 0 ? fullPath.slice(slash + 1) : fullPath
    return `${directory}${suffixBaseName(base, counter)}`
  }

  /**
   * Renames the LAST segment of `directoryPath` so the directory no longer
   * collides with a committed file of the same (case-folded) path.
   */
  private allocateDirectorySegment(
    directoryPath: string,
    segment: string,
    claimed: ReadonlyMap<string, string>
  ): string {
    const parent = directoryPath.slice(0, directoryPath.length - segment.length)
    let counter = 1
    for (;;) {
      counter += 1
      const candidate = `${parent}${suffixDirectoryName(segment, counter)}`
      const folded = foldEntryName(candidate)
      if (!this.fileNames.has(folded) && !this.directories.has(folded) && !claimed.has(folded)) {
        return candidate
      }
    }
  }
}
