export function getSharedFilesDirectoryKey(filesystemName: string, path: string): string {
  return `${filesystemName}\u0000${path || '/'}`
}

export function joinSharedFilePath(base: string, segment: string): string {
  const normalisedBase = base === '' || base === '/' ? '' : base.replace(/\/+$/, '')
  const normalisedSegment = segment.replace(/^\/+/, '')
  return `${normalisedBase}/${normalisedSegment}`
}

export function getSharedFileParentPath(path: string): string {
  if (!path || path === '/' || path === '') return '/'
  const stripped = path.replace(/\/+$/, '')
  const idx = stripped.lastIndexOf('/')
  if (idx <= 0) return '/'
  return stripped.slice(0, idx) || '/'
}

export function formatSharedFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
