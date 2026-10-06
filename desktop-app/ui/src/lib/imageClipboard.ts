/** Copy image bytes as PNG when the browser supports image clipboard writes. */
export async function copyImageBlobToClipboard(
  sourceBlob: Blob,
  isActive: () => boolean = () => true
): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const clipboardBlob =
      sourceBlob.type === 'image/png' ? sourceBlob : await convertBlobToPng(sourceBlob)
    if (!isActive()) return false
    if (clipboardBlob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])
      return true
    }
  }

  if (navigator.clipboard?.writeText) {
    const dataUrl = await blobToDataUrl(sourceBlob)
    if (!isActive()) return false
    await navigator.clipboard.writeText(dataUrl)
    return true
  }

  throw new Error('Image clipboard unavailable')
}

async function convertBlobToPng(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  } catch {
    return null
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const result = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
  if (typeof result !== 'string') throw new Error('Could not read the image')
  return result
}
