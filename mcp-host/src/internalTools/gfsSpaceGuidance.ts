import type { GfsDownloadStoreErrorCode } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

/**
 * Fixed model-facing guidance for the two space refusals of the GFS download
 * store. Both texts are constants: they carry no size, count, path or caller
 * identity, so they cannot reveal whose files use the space. An unmeasurable
 * volume (`volume_unmeasurable`) carries no guidance: no user action helps.
 */
export const GFS_DISK_FULL_GUIDANCE =
  'The Host workspace disk is full, so the file was not downloaded. Tell the user. ' +
  'Offer to list the files in their own workspace, which is the shell working directory ' +
  '(for example `du -sh -- * .[!.]* 2>/dev/null | sort -h`), and to delete the ones they ' +
  'no longer need with a shell_exec command they approve. Never list, read or delete ' +
  "another user's directory or anything outside the workspace."

// Deleting downloaded copies by hand cannot admit the download. The budget
// refusal comes when evicting every copy no running task protects would still
// not make room, or when a planned eviction fails to remove a copy, which
// stays charged until a sweep removes it. The per-caller and Host-wide
// protected caps, checked before any eviction, count only copies that running
// tasks protect. Kept files (generated files and chat attachments) count in
// the same budget and are never evicted. Tasks finishing (or being
// cancelled), copies expiring, kept files reaching their retention time, a
// confirmed delete of the user's own kept files and sweeps free that space.
const STORE_FULL =
  "The Host's storage for downloaded and kept files is full, so the file was not downloaded. Tell the user. " +
  'Space frees as running tasks finish, as downloaded copies expire, and as kept files (generated files and chat attachments) are deleted ' +
  `${Math.round(GFS_FILE_LIMITS.retentionMs / 3_600_000)} hours after they were made. `
const NEVER_OTHERS = "Never act on another user's tasks or files."

/** The storage-full guidance where the turn can delete the user's kept files. */
export const GFS_STORE_FULL_DELETE_GUIDANCE =
  STORE_FULL +
  'The user can free space now: list their kept files with clerum__kept_files_list and delete the ones they confirm with clerum__kept_files_delete. ' +
  'They can also finish or cancel their own running tasks. ' +
  NEVER_OTHERS

/** The storage-full guidance where the turn cannot delete kept files. */
export const GFS_STORE_FULL_GUIDANCE =
  STORE_FULL +
  'They can finish or cancel their own running tasks to free space sooner, then try again. ' +
  NEVER_OTHERS

/**
 * The guidance a store refusal carries to the model, if it has one. The
 * storage-full text names the kept-files delete only where the turn has it.
 */
export function gfsStoreSpaceGuidance(
  code: GfsDownloadStoreErrorCode,
  tools: { keptFilesDelete: boolean }
): string | undefined {
  if (code === 'disk_full') return GFS_DISK_FULL_GUIDANCE
  if (code === 'host_quota_exceeded')
    return tools.keptFilesDelete ? GFS_STORE_FULL_DELETE_GUIDANCE : GFS_STORE_FULL_GUIDANCE
  return undefined
}
