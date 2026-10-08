import type { GfsDownloadStoreErrorCode } from './gfsDownloadStore'

/**
 * Fixed model-facing guidance for the two space refusals of the GFS download
 * store. Both texts are constants: they carry no size, count, path or caller
 * identity, so they cannot reveal whose files use the space.
 */
export const GFS_DISK_FULL_GUIDANCE =
  'The Host workspace disk is full, so the file was not downloaded. Tell the user. ' +
  'Offer to list the files in their own workspace, which is the shell working directory ' +
  '(for example `du -sh -- * .[!.]* 2>/dev/null | sort -h`), and to delete the ones they ' +
  'no longer need with a shell_exec command they approve. Never list, read or delete ' +
  "another user's directory or anything outside the workspace."

export const GFS_CACHE_FULL_GUIDANCE =
  "The Host's cache of downloaded files is full, so the file was not downloaded. " +
  'Space frees as other tasks finish and cached copies expire. Tell the user. ' +
  'They may delete their own downloaded copies under .gfs-downloads in their workspace ' +
  'that no running task is using, with a shell_exec command they approve; a task that ' +
  "still needs a deleted copy downloads it again. Never delete another user's copies."

/** The guidance a store refusal carries to the model, if it has one. */
export function gfsStoreSpaceGuidance(code: GfsDownloadStoreErrorCode): string | undefined {
  if (code === 'disk_full') return GFS_DISK_FULL_GUIDANCE
  if (code === 'host_quota_exceeded') return GFS_CACHE_FULL_GUIDANCE
  return undefined
}
