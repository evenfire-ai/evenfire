import { GFS_FILE_THUMBNAIL_MAX_BYTES } from '@constants/gfsFileThumbnail'

/**
 * Decide whether a row entry should render a small inline thumbnail
 * (currently image files only, and small enough to fetch cheaply).
 *
 * `bytes` is the metadata-declared size from the GFS listing. We use
 * the metadata size first so we can skip the request entirely when the
 * file is already known to be larger than the thumbnail budget.
 */
export function shouldRenderGfsFileThumbnail(opts: {
  isImage: boolean
  bytes: number
  maxBytes?: number
}): boolean {
  if (!opts.isImage) return false
  const budget = opts.maxBytes ?? GFS_FILE_THUMBNAIL_MAX_BYTES
  return opts.bytes <= budget
}
