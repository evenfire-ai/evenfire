import type { GfsDownloadStoreErrorCode } from './gfsDownloadStore'

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
// stays charged until a sweep removes it. The per-caller cap, checked before
// any eviction, counts only copies the caller's running tasks protect. Only
// tasks finishing (or being cancelled), copies expiring and sweeps free that
// space.
export const GFS_CACHE_FULL_GUIDANCE =
  "The Host's cache of downloaded files is full, so the file was not downloaded. " +
  'Space frees as tasks finish and downloaded copies expire. Tell the user. ' +
  'They can finish or cancel their own running tasks to free space sooner, then try again. ' +
  "Never act on another user's tasks or files."

/** The guidance a store refusal carries to the model, if it has one. */
export function gfsStoreSpaceGuidance(code: GfsDownloadStoreErrorCode): string | undefined {
  if (code === 'disk_full') return GFS_DISK_FULL_GUIDANCE
  if (code === 'host_quota_exceeded') return GFS_CACHE_FULL_GUIDANCE
  return undefined
}
