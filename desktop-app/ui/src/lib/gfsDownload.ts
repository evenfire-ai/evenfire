/**
 * Route single-file GFS saves through the trusted main-process owner shared by
 * Files, Sidebar, and Preview. The preview-vs-download decision remains in
 * `gfsPreview`; the renderer receives only a terminal receipt, never the bytes
 * or filesystem publication authority.
 */
export async function saveGfsFileToDisk(uri: string, _name: string, sessionGeneration: number) {
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
    throw new Error('The Desktop session changed before Download started.')
  }
  return window.clerum.gfs.saveToDisk(uri, sessionGeneration)
}
