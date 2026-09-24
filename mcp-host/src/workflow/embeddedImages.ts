/**
 * Reading, sizing and preparing the images the document generators embed.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as path from 'path'
import { imageTarget } from './inlineMarkup'

export interface ImageSize {
  width: number
  height: number
}

/** Pixels per metre at 96 dpi, the density a PNG carries when it is not oversampled. */
export const PNG_BASE_PPM = 3780

function isPng(buf: Buffer): boolean {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8
}

/** The EXIF orientation of a JPEG (1 = upright), from its APP1 segment. */
function jpegOrientation(buf: Buffer): number {
  if (!isJpeg(buf)) return 1
  let i = 2
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]
    const length = buf.readUInt16BE(i + 2)
    if (marker === 0xda) break
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const tiff = i + 10
      const le = buf.toString('latin1', tiff, tiff + 2) === 'II'
      const u16 = (at: number) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at))
      const u32 = (at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
      if (tiff + 8 > buf.length) return 1
      const ifd = tiff + u32(tiff + 4)
      if (ifd + 2 > buf.length) return 1
      for (let n = 0, count = u16(ifd); n < count; n++) {
        const entry = ifd + 2 + n * 12
        if (entry + 10 > buf.length) return 1
        if (u16(entry) === 0x0112) return u16(entry + 8)
      }
      return 1
    }
    i += 2 + length
  }
  return 1
}

/** Pixel dimensions of a PNG or JPEG, read from its header. */
function headerSize(buf: Buffer): ImageSize | undefined {
  // PNG: IHDR is the first chunk, width and height at byte 16.
  if (isPng(buf)) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  // JPEG: walk the segment chain to the frame header, which carries the size.
  if (isJpeg(buf)) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      // SOF0..SOF15, skipping the non-frame markers in that range.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return undefined
}

/** 1200 dpi. A density past it is not one to show a picture at: it would shrink it to a speck. */
const MAX_DENSITY_RATIO = 12.5

/** Oversampling factor recorded in a PNG's pHYs chunk; 1 when absent or implausible. */
function pngDensityRatio(buf: Buffer): number {
  if (!isPng(buf)) return 1
  let at = 8
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (type === 'pHYs' && at + 8 + 9 <= buf.length) {
      const ppm = buf.readUInt32BE(at + 8)
      const unit = buf.readUInt8(at + 16)
      if (unit === 1 && ppm > 0) {
        const ratio = ppm / PNG_BASE_PPM
        return Number.isFinite(ratio) && ratio >= 1 && ratio <= MAX_DENSITY_RATIO ? ratio : 1
      }
      return 1
    }
    if (type === 'IDAT' || type === 'IEND') return 1
    at += 12 + length
  }
  return 1
}

/**
 * Size an image should be shown at, in CSS pixels at 96 dpi. An oversampled
 * image reports fewer display pixels than it stores, which is what keeps its
 * type at the size it was laid out for.
 */
function displaySize(buf: Buffer): ImageSize | undefined {
  const intrinsic = headerSize(buf)
  if (!intrinsic) return undefined
  const ratio = pngDensityRatio(buf)
  if (ratio <= 1) return intrinsic
  return {
    width: Math.max(1, Math.round(intrinsic.width / ratio)),
    height: Math.max(1, Math.round(intrinsic.height / ratio)),
  }
}

function readFile(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file)
  } catch {
    return undefined
  }
}

/**
 * Pixel dimensions of a PNG or JPEG file. Embedding an image into a fixed box
 * distorts it — a 2:1 chart placed in a 16:9 slot is visibly stretched — so
 * every embedder sizes against the real aspect ratio.
 */
export function imageIntrinsicSize(file: string): ImageSize | undefined {
  const buf = readFile(file)
  return buf ? headerSize(buf) : undefined
}

export function imageDisplaySize(file: string): ImageSize | undefined {
  const buf = readFile(file)
  return buf ? displaySize(buf) : undefined
}

/**
 * Box for an image of `size` that fits `max`, always in the image's own
 * proportions. An explicit width or height is honoured and the other side
 * derived; both together are read as a box to fit in, because a model that
 * sends both almost never means to distort the image. Whatever was asked for
 * is then scaled down until it fits the page.
 */
export function fitImageSize(
  size: ImageSize | undefined,
  max: ImageSize,
  requested: { width?: number; height?: number } = {}
): ImageSize {
  const reqW = requested.width && requested.width > 0 ? requested.width : undefined
  const reqH = requested.height && requested.height > 0 ? requested.height : undefined
  let width: number
  let height: number
  if (!size) {
    if (!reqW && !reqH) return { width: max.width, height: max.height }
    width = reqW ?? max.width
    height = reqH ?? max.height
  } else {
    const ratio = size.width / size.height
    if (reqW && reqH) {
      const scale = Math.min(reqW / size.width, reqH / size.height)
      width = size.width * scale
      height = size.height * scale
    } else if (reqW) {
      width = reqW
      height = reqW / ratio
    } else if (reqH) {
      width = reqH * ratio
      height = reqH
    } else {
      width = size.width
      height = size.height
    }
  }
  const scale = Math.min(max.width / width, max.height / height, 1)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** fitImageSize for an image on disk. */
export function fitImageBox(
  file: string,
  max: ImageSize,
  requested: { width?: number; height?: number } = {}
): ImageSize {
  return fitImageSize(imageDisplaySize(file), max, requested)
}

/** The path an image argument names: a filename, or an object carrying `path`. */
export function imageRefPath(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref.trim() || undefined
  if (ref && typeof ref === 'object') {
    const p = (ref as { path?: unknown }).path
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return undefined
}

/**
 * Resolve an image path inside `outputDir`.
 *
 * A path that escapes the folder is an error. The one exception is
 * an absolute path whose file name exists in the folder: models copy the path
 * a generator reported in another mode (`/output/chart.png`) or invent one, and
 * failing the whole document for it helped nobody. Returns undefined, with a
 * warning, when the file is missing.
 */
export function resolveImagePath(
  requested: string,
  outputDir: string,
  warnings: string[]
): string | undefined {
  const root = path.resolve(outputDir)
  const resolved = path.resolve(root, requested)
  const inside = resolved.startsWith(root + path.sep)
  let file = resolved
  if (!inside) {
    const sibling = path.join(root, path.basename(requested))
    if (!path.isAbsolute(requested) || !fs.existsSync(sibling)) {
      throw new Error(`path traversal blocked: ${requested}`)
    }
    warnings.push(
      `'${requested}' is outside the output folder, so '${path.basename(requested)}' from the output folder was used.`
    )
    file = sibling
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    warnings.push(`Image '${requested}' was not found in the output folder and was left out.`)
    return undefined
  }
  if (!insideRealFolder(file, root)) throw new Error(`path traversal blocked: ${requested}`)
  return file
}

/** Whether `file`, links resolved, is inside `root`, links resolved. */
function insideRealFolder(file: string, root: string): boolean {
  try {
    return fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)
  } catch {
    return false
  }
}

export interface EmbeddableImage {
  /** Resolved file inside the output folder. */
  path: string
  /** PNG or JPEG bytes; other formats arrive converted to PNG. */
  data: Buffer
  format: 'png' | 'jpeg'
  /** Display size in CSS pixels. */
  width: number
  height: number
  /** Size of the stored bitmap, which is larger than the display size when oversampled. */
  pixels: ImageSize
}

/**
 * Largest image decoded for conversion, in pixels (64 MB of RGBA). The canvas
 * library aborts the whole process, uncatchably, when it cannot allocate a
 * bitmap, so every size is checked before decoding: a raster's from its file
 * header, an SVG's from its root element, which is refused when unreadable.
 */
const MAX_DECODE_PIXELS = 16_000_000
const MAX_SVG_SIDE = 2048

/** Width and height from a GIF, WebP or BMP header, read before the image is decoded. */
function declaredSize(buf: Buffer): ImageSize | undefined {
  if (buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf.length >= 26 && buf.toString('latin1', 0, 2) === 'BM') {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
  }
  if (
    buf.length >= 30 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = buf.toString('latin1', 12, 16)
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
  }
  return undefined
}

const SVG_UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  em: 16,
  ex: 8,
}

const SVG_NUMBER = '\\+?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?'

/**
 * The root's `name` attribute in pixels: undefined when it is absent or a
 * percentage, which leaves the size to the viewBox, and null when it is set in
 * a form this reader cannot size, so the image is not decoded at all.
 */
function svgLength(tag: string, name: string): number | null | undefined {
  const attr = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  if (!attr) return undefined
  const m = new RegExp(`^\\s*(${SVG_NUMBER})\\s*([a-z%]*)\\s*$`, 'i').exec(attr[1])
  if (m?.[2] === '%') return undefined
  const factor = m ? SVG_UNIT_PX[m[2].toLowerCase()] : undefined
  return m && factor ? Number(m[1]) * factor : null
}

/**
 * An SVG whose root size fits the decode budget. The canvas library rasterizes
 * an SVG at its declared size, so a huge width, height or viewBox is rewritten
 * to a smaller one; the drawing is vector, so it scales without loss.
 */
function boundedSvg(buf: Buffer): Buffer | undefined {
  const text = buf.toString('utf8')
  const open = /<svg\b[^<>]*>/i.exec(text)
  if (!open) return undefined
  const tag = open[0]
  const box =
    /\sviewBox\s*=\s*["']\s*[-0-9.e]+[\s,]+[-0-9.e]+[\s,]+([0-9.e]+)[\s,]+([0-9.e]+)/i.exec(tag)
  const givenWidth = svgLength(tag, 'width')
  const givenHeight = svgLength(tag, 'height')
  if (givenWidth === null || givenHeight === null) return undefined
  const width = givenWidth ?? (box ? Number(box[1]) : undefined)
  const height = givenHeight ?? (box ? Number(box[2]) : undefined)
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return buf
  const scale = Math.min(
    1,
    MAX_SVG_SIDE / Math.max(width, height),
    Math.sqrt(MAX_DECODE_PIXELS / (width * height))
  )
  if (scale >= 1) return buf
  const sized = tag
    .replace(/\s(width|height)\s*=\s*(["'])[^"']*\2/gi, '')
    .replace(
      /^<svg\b/i,
      `<svg width="${Math.max(1, Math.floor(width * scale))}" height="${Math.max(1, Math.floor(height * scale))}"` +
        (box ? '' : ` viewBox="0 0 ${width} ${height}"`)
    )
  return Buffer.from(
    text.slice(0, open.index) + sized + text.slice(open.index + tag.length),
    'utf8'
  )
}

function isSvg(buf: Buffer): boolean {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).trimStart()
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(head)
}

/** Bytes safe to hand to the decoder, or undefined for a format or size this tool does not convert. */
function decodable(raw: Buffer): Buffer | undefined {
  if (isSvg(raw)) return boundedSvg(raw)
  const size = isJpeg(raw) ? headerSize(raw) : declaredSize(raw)
  if (!size || !size.width || !size.height) return undefined
  return size.width * size.height <= MAX_DECODE_PIXELS ? raw : undefined
}

/**
 * PNG bytes of images decoded ahead of a render, by file and version. The
 * canvas library decodes GIF, WebP and SVG asynchronously, and an image drawn
 * before it finishes comes out fully transparent; the generators read images
 * synchronously deep inside their layout code, so the decoding happens first.
 */
const decoded = new Map<string, Buffer>()
const MAX_DECODED = 32

function decodedKey(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    return `${file}\0${stat.size}\0${stat.mtimeMs}`
  } catch {
    return undefined
  }
}

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i
// As the markdown reader matches an image: the alt text stops at the next
// bracket, so a line of unclosed "![" is scanned once, not from every opening.
const MARKDOWN_IMAGE = /!\[[^[\]\n]*\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g

function collectImageNames(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 64) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (IMAGE_NAME.test(text) && text.length < 1024) into.add(text)
    if (text.includes('!['))
      for (const m of text.matchAll(MARKDOWN_IMAGE)) into.add(imageTarget(m[1]))
  } else if (Array.isArray(value)) {
    for (const item of value) collectImageNames(item, into, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectImageNames(item, into, depth + 1)
  }
}

/**
 * Decode every image an argument names that is neither PNG nor JPEG, so
 * loadEmbeddableImage can convert it. Never throws: whatever cannot be decoded
 * here is reported by loadEmbeddableImage when a generator asks for it.
 */
export async function predecodeImages(args: unknown, outputDir: string): Promise<void> {
  const names = new Set<string>()
  collectImageNames(args, names)
  const root = path.resolve(outputDir)
  for (const name of names) {
    try {
      const resolved = path.resolve(root, name)
      const file = resolved.startsWith(root + path.sep)
        ? resolved
        : path.isAbsolute(name)
          ? path.join(root, path.basename(name))
          : undefined
      const key = file && decodedKey(file)
      if (!file || !key || decoded.has(key) || !insideRealFolder(file, root)) continue
      const raw = fs.readFileSync(file)
      if (isPng(raw) || (isJpeg(raw) && jpegOrientation(raw) <= 1)) continue
      const input = decodable(raw)
      if (!input) continue
      const image = await loadImage(input)
      if (!image.width || !image.height || image.width * image.height > MAX_DECODE_PIXELS) continue
      const canvas = createCanvas(image.width, image.height)
      canvas.getContext('2d').drawImage(image, 0, 0)
      // The decoder applies the EXIF rotation; re-encoding drops it, so every
      // format shows the photo the same way up.
      decoded.set(
        key,
        isJpeg(raw) ? canvas.toBuffer('image/jpeg', 92) : canvas.toBuffer('image/png')
      )
      while (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value as string)
    } catch {
      // Left for loadEmbeddableImage to report against the argument that named it.
    }
  }
}

/**
 * Load an image argument for embedding. The format is read from the bytes, not
 * the extension, so a GIF named .png still embeds; formats other than PNG and
 * JPEG need predecodeImages first. Anything missing or unreadable is left out
 * with a warning naming it, so the agent learns why it is not in the document.
 */
export function loadEmbeddableImage(
  ref: unknown,
  outputDir: string,
  warnings: string[],
  label = 'image'
): EmbeddableImage | undefined {
  const requested = imageRefPath(ref)
  if (requested && /^(?:https?|ftp|data):/i.test(requested)) {
    const shown = requested.length > 60 ? `${requested.slice(0, 57)}...` : requested
    warnings.push(
      `${label} '${shown}' is a web address or inline data, and images are not downloaded; ` +
        'save the image to the output folder first and pass its file name. It was left out.'
    )
    return undefined
  }
  if (!requested) {
    warnings.push(
      `${label} needs a file name, such as the one clerum__generate_chart returns; it was left out.`
    )
    return undefined
  }
  const file = resolveImagePath(requested, outputDir, warnings)
  if (!file) return undefined
  const raw = readFile(file)
  const key = decodedKey(file)
  const upright = raw && (isPng(raw) || (isJpeg(raw) && jpegOrientation(raw) <= 1))
  const data = upright ? raw : key ? decoded.get(key) : undefined
  const size = data ? displaySize(data) : undefined
  const pixels = data ? headerSize(data) : undefined
  if (!data || !size || !pixels) {
    warnings.push(`'${requested}' is not an image this tool can read and was left out.`)
    return undefined
  }
  return { path: file, data, format: isPng(data) ? 'png' : 'jpeg', ...size, pixels }
}

export function imageDataUrl(image: EmbeddableImage): string {
  return `data:image/${image.format};base64,${image.data.toString('base64')}`
}
