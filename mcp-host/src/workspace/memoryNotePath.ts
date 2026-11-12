/**
 * Where the memory tools (`memory_write`, `memory_read`) put a path.
 *
 * A named note of a person lives in their `memory/` folder: a free relative
 * path `p` becomes `memory/<p>`, and every note is Markdown (`.md` is appended
 * unless the last path segment already ends in `.md`). Paths that are refused
 * today, collective paths and `daily/...` are returned unchanged, so they keep
 * today's routing and today's refusal messages.
 *
 * The function is pure and knows nothing of the workspace type: on a
 * `ScopedWorkspace` the result is relative to the caller's folder (or the Host
 * root for collective paths); on a flat `WorkspaceService` the same mapping
 * applies under its root.
 */
import * as path from 'path'
import { isProtectedWorkspacePath } from './protectedPaths'
import { isCollectivePath, normalizeRel } from './scopedWorkspace'
import { isLockedPath } from './service'

/** Per-user folder of named memory notes. */
export const MEMORY_NOTES_DIR = 'memory'

const DAILY_DIR = 'daily'
const USERS_DIR = 'users'

/**
 * Notes are only Markdown: append `.md` unless the last path segment already
 * ends in `.md`. Case-sensitive, like the `.md` test `memory_search` uses to
 * pick files, so every note the tool writes is searched.
 */
function withMarkdownExtension(relativePath: string): string {
  const lastSegment = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return lastSegment.endsWith('.md') ? relativePath : `${relativePath}.md`
}

/** Path the memory tools use for `raw`. Unchanged when `raw` is refused today or exempt; else `memory/<normalized>`. */
export function memoryNotePath(raw: string): string {
  // Refused by WorkspaceService.resolvePath with today's error.
  if (raw.includes('\0') || path.isAbsolute(raw) || raw.includes('..')) return raw
  // Refused as a protected path with today's message.
  if (isProtectedWorkspacePath(raw)) return raw
  // Redundant by construction: every locked name is also a collective path,
  // returned unchanged below. Kept so a locked name never reaches the prefix.
  if (isLockedPath(raw)) return raw
  const normalized = normalizeRel(raw)
  // Another user's namespace: CrossUserAccessError on a ScopedWorkspace, as today.
  if (normalized === USERS_DIR || normalized.startsWith(`${USERS_DIR}/`)) return raw
  // The caller's folder itself: fails as today.
  if (normalized === '' || normalized === '.') return raw
  // Collective memory stays at the Host root.
  if (isCollectivePath(raw)) return raw
  // The daily log stays where daily_log writes it and the prompt reads it.
  if (normalized.startsWith(`${DAILY_DIR}/`)) return raw
  // Already in the notes folder: not doubled.
  if (normalized.startsWith(`${MEMORY_NOTES_DIR}/`)) return withMarkdownExtension(normalized)
  return withMarkdownExtension(`${MEMORY_NOTES_DIR}/${normalized}`)
}
