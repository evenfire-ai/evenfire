/**
 * Where the memory tools (`memory_write`, `memory_read`) put a path.
 *
 * A named note of a person lives in their `memory/` folder: a free relative
 * path `p` becomes `memory/<p>`, and every note is Markdown (trailing dots of
 * the last path segment are removed, then `.md` is appended unless that segment
 * already ends in `.md`; `notes.` and `notes` are the same note). Paths refused
 * by their text (a NUL byte, an absolute path, `..`, a protected or locked name,
 * another user's namespace, the caller's folder itself), collective paths and
 * `daily/...` are returned unchanged and keep their routing and messages. A
 * refusal that depended on what the path pointed to (a symlink, an existing
 * directory) no longer applies to a free name: the name now addresses a note
 * under `memory/`.
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
 * Notes are only Markdown: remove every trailing `.` of the last path segment,
 * then append `.md` unless that segment already ends in `.md`. So `notes.` and
 * `notes` name the same note. Case-sensitive, like the `.md` test
 * `memory_search` uses to pick files, so every note the tool writes is searched.
 */
function withMarkdownExtension(relativePath: string): string {
  const segmentStart = relativePath.lastIndexOf('/') + 1
  const lastSegment = relativePath.slice(segmentStart).replace(/\.+$/, '')
  const stripped = relativePath.slice(0, segmentStart) + lastSegment
  return lastSegment.endsWith('.md') ? stripped : `${stripped}.md`
}

/** Path the memory tools use for `raw`. Unchanged when `raw` is refused by its text, collective or under `daily/`; else `memory/<normalized>` as a Markdown note. */
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
