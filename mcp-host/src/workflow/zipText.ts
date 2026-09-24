/**
 * Text parts of the Office packages the generators write, kept whole.
 */
import JSZip from 'jszip'

let whole = false

/**
 * JSZip encodes a string it is handed to UTF-8 in chunks of 16K characters, so
 * a character outside the BMP, such as an emoji, that straddles a chunk edge is
 * written as two U+FFFD. ExcelJS and pptxgenjs hand it their XML as strings.
 * From the first call on, a text string is handed over as its UTF-8 bytes,
 * which are what JSZip writes for it when nothing is split. Set when a package
 * is written, so importing this module changes nothing.
 */
export function keepZipTextWhole(): void {
  if (whole) return
  whole = true
  const proto = JSZip.prototype as unknown as { file: (...args: unknown[]) => unknown }
  const file = proto.file
  proto.file = function (this: unknown, ...args: unknown[]) {
    const [name, data, options] = args
    const binary = options as { binary?: boolean; base64?: boolean } | undefined
    if (args.length > 1 && typeof data === 'string' && !binary?.binary && !binary?.base64) {
      return file.call(this, name, Buffer.from(data, 'utf8'), options)
    }
    return file.apply(this, args)
  }
}
