/**
 * Save a GFS resource to disk: download its bytes and trigger a browser save.
 * The single place that performs the save-to-disk, shared by the Files page and
 * the sidebar file explorer (spec 18 §3.A.4) so the "download a non-previewable
 * file" path is not duplicated — the preview-vs-download DECISION stays in
 * `gfsPreview`. Throws on a download failure so each caller keeps its own
 * fail-closed (authority) and toast handling.
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
