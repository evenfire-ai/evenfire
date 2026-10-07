/**
 * Save GFS content to disk through the renderer's anchor-download path — the
 * single place that performs the save-to-disk, shared by the Files page, the
 * sidebar file explorer (spec 18 §3.A.4) and the folder-zip export (BUG-175),
 * so the "download a non-previewable file" path is not duplicated. The
 * preview-vs-download DECISION stays in `gfsPreview`. Throws on a download
 * failure so each caller keeps its own fail-closed (authority) and toast
 * handling.
 */
export async function saveGfsFileToDisk(uri: string, name: string): Promise<void> {
  const { bytes } = await window.clerum.gfs.download(uri)
  const url = URL.createObjectURL(new Blob([bytes]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
