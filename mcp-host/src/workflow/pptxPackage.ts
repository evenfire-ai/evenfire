/** Post-processing of the written package. */
import JSZip from 'jszip'

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/
const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>/g
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g

/**
 * pptxgenjs writes paragraph properties before every run of a paragraph, where
 * a paragraph may have them once, before its first run. The first set is the
 * paragraph's own (its bullet, alignment and direction), so the rest go.
 */
export async function withOnePropertiesPerParagraph(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  let changed = false
  for (const name of Object.keys(zip.files).filter(n => SLIDE_PART.test(n))) {
    const xml = await zip.file(name)!.async('string')
    const fixed = xml.replace(PARAGRAPH, (_p, inner: string) => {
      let seen = false
      const once = inner.replace(PARAGRAPH_PROPERTIES, props =>
        seen ? '' : ((seen = true), props)
      )
      return `<a:p>${once}</a:p>`
    })
    if (fixed !== xml) {
      zip.file(name, fixed)
      changed = true
    }
  }
  // Stored, as pptxgenjs writes the package, so the pictures are not compressed again.
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) : buffer
}
