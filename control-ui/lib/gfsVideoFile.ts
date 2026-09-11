import { GFS_VIDEO_FILE_EXTENSIONS } from '@constants/gfsVideoFile'

export function isGfsVideoFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return false
  return GFS_VIDEO_FILE_EXTENSIONS.includes(extension)
}
