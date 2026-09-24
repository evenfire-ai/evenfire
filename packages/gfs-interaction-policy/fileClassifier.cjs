'use strict'

/**
 * Isomorphic byte classifier shared by Desktop (renderer and main), Control UI
 * and mcp-host. It uses only Uint8Array and TextDecoder so the same decision is
 * made in a browser and in Node. The bytes decide the class; the declared media
 * type and the filename extension only break ties inside the same family, or
 * stand in for missing bytes when a short prefix carries no contrary evidence.
 *
 * Classification never rejects: an unknown or misleading file is reported as
 * `binary_unsupported` and/or `mismatch: true`, and callers decide what to do.
 */

const FILE_CLASSES = Object.freeze([
  'text',
  'markdown',
  'html',
  'code',
  'svg',
  'jpeg',
  'png',
  'pdf',
  'docx',
  'xlsx',
  'binary_unsupported',
])

const TEXT_CLASSES = new Set(['text', 'markdown', 'html', 'code', 'svg'])
const IMAGE_CLASSES = new Set(['jpeg', 'png'])
const DOCUMENT_BINARY_CLASSES = new Set(['pdf', 'docx', 'xlsx'])

/** A prefix shorter than this carries too little evidence to override the declared type. */
const DECLARED_EVIDENCE_PREFIX_BYTES = 65536
const PDF_SIGNATURE_WINDOW_BYTES = 1024
const TEXT_ROOT_SCAN_CHARS = 4096

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ZIP_MEDIA_TYPE = 'application/zip'

const MEDIA_TYPE_BY_CLASS = Object.freeze({
  text: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
  code: 'text/plain',
  svg: 'image/svg+xml',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  docx: DOCX_MEDIA_TYPE,
  xlsx: XLSX_MEDIA_TYPE,
  binary_unsupported: 'application/octet-stream',
})

const CODE_EXTENSIONS = Object.freeze([
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.tsv',
  '.xml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.scala',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.php',
  '.lua',
  '.r',
  '.dart',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
  '.graphql',
  '.proto',
  '.tf',
])

const CODE_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'text/xml',
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
  'application/toml',
  'text/csv',
  'text/tab-separated-values',
  'application/javascript',
  'text/javascript',
  'application/typescript',
  'text/x-python',
  'application/x-sh',
  'application/sql',
  'text/css',
])

const CLASS_BY_EXTENSION = Object.freeze({
  '.txt': 'text',
  '.text': 'text',
  '.log': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  ...Object.fromEntries(CODE_EXTENSIONS.map(extension => [extension, 'code'])),
})

function familyOf(fileClass) {
  if (TEXT_CLASSES.has(fileClass)) return 'text'
  if (IMAGE_CLASSES.has(fileClass)) return 'image'
  if (DOCUMENT_BINARY_CLASSES.has(fileClass)) return 'document_binary'
  return 'binary_unsupported'
}

function normalizeMediaType(value) {
  if (typeof value !== 'string') return null
  const essence = value.split(';', 1)[0].trim().toLowerCase()
  return essence || null
}

function classFromMediaType(mediaType) {
  const essence = normalizeMediaType(mediaType)
  if (!essence) return null
  if (essence === 'image/jpeg' || essence === 'image/jpg') return 'jpeg'
  if (essence === 'image/png') return 'png'
  if (essence === 'application/pdf') return 'pdf'
  if (essence === DOCX_MEDIA_TYPE) return 'docx'
  if (essence === XLSX_MEDIA_TYPE) return 'xlsx'
  if (essence === 'image/svg+xml') return 'svg'
  if (essence === 'text/markdown' || essence === 'text/x-markdown') return 'markdown'
  if (essence === 'text/html') return 'html'
  if (CODE_MEDIA_TYPES.has(essence)) return 'code'
  if (essence.startsWith('text/')) return 'text'
  return null
}

function extensionOf(filename) {
  if (typeof filename !== 'string') return ''
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1)
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === base.length - 1) return ''
  return base.slice(lastDot).toLowerCase()
}

function classFromExtension(filename) {
  const extension = extensionOf(filename)
  return Object.prototype.hasOwnProperty.call(CLASS_BY_EXTENSION, extension)
    ? CLASS_BY_EXTENSION[extension]
    : null
}

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ZIP_LOCAL_HEADER_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

function hasPdfSignature(bytes) {
  const limit = Math.min(bytes.length, PDF_SIGNATURE_WINDOW_BYTES) - PDF_SIGNATURE.length
  for (let offset = 0; offset <= limit; offset += 1) {
    let matched = true
    for (let index = 0; index < PDF_SIGNATURE.length; index += 1) {
      if (bytes[offset + index] !== PDF_SIGNATURE[index]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x1000000
  )
}

const ZIP_ENTRY_NAME_DECODER = new TextDecoder('utf-8')
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_EOCD_MIN_LENGTH = 22
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50
const ZIP_LOCAL_HEADER = 0x04034b50

/**
 * Entry names from the ZIP central directory, or null when the archive has no
 * readable end-of-central-directory record. Null is reported as "not an Office
 * document", never guessed.
 */
function zipCentralDirectoryNames(bytes) {
  const searchStart = Math.max(0, bytes.length - (ZIP_EOCD_MIN_LENGTH + 0xffff))
  let eocd = -1
  for (let offset = bytes.length - ZIP_EOCD_MIN_LENGTH; offset >= searchStart; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return null
  const entryCount = readUint16(bytes, eocd + 10)
  let cursor = readUint32(bytes, eocd + 16)
  const names = []
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (cursor + 46 > bytes.length || readUint32(bytes, cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      return null
    }
    const nameLength = readUint16(bytes, cursor + 28)
    const extraLength = readUint16(bytes, cursor + 30)
    const commentLength = readUint16(bytes, cursor + 32)
    const nameStart = cursor + 46
    if (nameStart + nameLength > bytes.length) return null
    names.push(ZIP_ENTRY_NAME_DECODER.decode(bytes.subarray(nameStart, nameStart + nameLength)))
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return names
}

/**
 * Entry names from the local file headers that fit inside a prefix. Stops at the
 * first entry whose size is deferred to a data descriptor, because the next
 * header cannot be located without inflating that entry.
 */
function zipLocalHeaderNames(bytes) {
  const names = []
  let cursor = 0
  while (cursor + 30 <= bytes.length && readUint32(bytes, cursor) === ZIP_LOCAL_HEADER) {
    const flags = readUint16(bytes, cursor + 6)
    const compressedSize = readUint32(bytes, cursor + 18)
    const nameLength = readUint16(bytes, cursor + 26)
    const extraLength = readUint16(bytes, cursor + 28)
    const nameStart = cursor + 30
    if (nameStart + nameLength > bytes.length) break
    names.push(ZIP_ENTRY_NAME_DECODER.decode(bytes.subarray(nameStart, nameStart + nameLength)))
    if ((flags & 0x08) !== 0) break
    cursor = nameStart + nameLength + extraLength + compressedSize
  }
  return names
}

function officeClassFromZipNames(names) {
  if (!names) return null
  const hasWord = names.some(name => name.startsWith('word/'))
  const hasSheet = names.some(name => name.startsWith('xl/'))
  if (hasWord && !hasSheet) return 'docx'
  if (hasSheet && !hasWord) return 'xlsx'
  return null
}

/** Length of the prefix that ends on a complete UTF-8 sequence. */
function completeUtf8Length(bytes) {
  let continuation = 0
  for (let index = bytes.length - 1; index >= 0 && continuation < 4; index -= 1) {
    const byte = bytes[index]
    if ((byte & 0xc0) === 0x80) {
      continuation += 1
      continue
    }
    let expected = 1
    if ((byte & 0xe0) === 0xc0) expected = 2
    else if ((byte & 0xf0) === 0xe0) expected = 3
    else if ((byte & 0xf8) === 0xf0) expected = 4
    return continuation + 1 < expected ? index : bytes.length
  }
  return bytes.length
}

function hasDisallowedControl(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

/**
 * Decoded text when the bytes are strict UTF-8 without C0/C1 controls (TAB, LF
 * and CR excepted), else null. A UTF-8 byte order mark is accepted and dropped.
 */
function decodeStrictText(bytes, partial) {
  const usable = partial ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(usable)
  } catch {
    return null
  }
  return hasDisallowedControl(text) ? null : text
}

function stripLeadingMarkup(text) {
  let rest = text.slice(0, TEXT_ROOT_SCAN_CHARS).replace(/^\s+/, '')
  for (;;) {
    const before = rest
    rest = rest
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .replace(/^<!DOCTYPE\s+svg[\s\S]*?>\s*/i, '')
    if (rest === before) return rest
  }
}

function textClassFromContent(text) {
  const head = stripLeadingMarkup(text)
  if (/^<svg[\s>/]/i.test(head)) return 'svg'
  if (/^<!DOCTYPE\s+html[\s>]/i.test(head) || /^<html[\s>]/i.test(head)) return 'html'
  return null
}

/**
 * Inside the text family the content decides svg and html; otherwise the
 * declared class breaks the tie. SVG is never granted by the name alone.
 */
function textClassFor(text, expectedClass) {
  const fromContent = textClassFromContent(text)
  if (fromContent) return fromContent
  if (expectedClass && expectedClass !== 'svg' && familyOf(expectedClass) === 'text') {
    return expectedClass
  }
  return 'text'
}

function result(fileClass, detection, mismatch, detectedMediaType) {
  const textReadable = TEXT_CLASSES.has(fileClass)
  return {
    class: fileClass,
    detectedMediaType: detectedMediaType ?? MEDIA_TYPE_BY_CLASS[fileClass],
    detection,
    textReadable,
    reader: textReadable ? 'text' : 'none',
    modelImageInput: IMAGE_CLASSES.has(fileClass) ? 'candidate' : 'unsupported',
    mismatch,
  }
}

/**
 * A generic text media type such as `text/plain` names only the family, so a
 * text-family extension (`.md`, `.py`, `.html`) supplies the subclass.
 */
function expectedClassFor(mediaTypeClass, extensionClass) {
  if (mediaTypeClass === 'text' && extensionClass && familyOf(extensionClass) === 'text') {
    return extensionClass
  }
  return mediaTypeClass ?? extensionClass
}

function mismatchFor(detectedClass, mediaTypeClass, extensionClass) {
  const family = familyOf(detectedClass)
  return [mediaTypeClass, extensionClass].some(
    expected => expected !== null && familyOf(expected) !== family
  )
}

/**
 * Evidence-based classification. `partial` means `bytes` is a prefix of a longer
 * file: ZIP entries then come from local headers and a trailing incomplete
 * UTF-8 sequence is ignored.
 */
function classifyFromEvidence(bytes, partial, expectedClass) {
  if (startsWith(bytes, JPEG_SIGNATURE)) return { fileClass: 'jpeg', detection: 'magic' }
  if (startsWith(bytes, PNG_SIGNATURE)) return { fileClass: 'png', detection: 'magic' }
  if (startsWith(bytes, ZIP_LOCAL_HEADER_SIGNATURE)) {
    const names = partial ? zipLocalHeaderNames(bytes) : zipCentralDirectoryNames(bytes)
    const officeClass = officeClassFromZipNames(names)
    if (officeClass) return { fileClass: officeClass, detection: 'magic' }
    return { fileClass: 'binary_unsupported', detection: 'magic', zip: true }
  }
  if (hasPdfSignature(bytes)) return { fileClass: 'pdf', detection: 'magic' }
  const text = decodeStrictText(bytes, partial)
  if (text !== null) {
    return { fileClass: textClassFor(text, expectedClass), detection: 'text_utf8', text: true }
  }
  return { fileClass: 'binary_unsupported', detection: 'magic' }
}

const SIGNATURE_CLASSES = new Set(['jpeg', 'png', 'pdf', 'docx', 'xlsx'])

/** Whether a short prefix without an identifying signature is compatible with the declared class. */
function prefixSupportsDeclared(evidence, bytesLength, expectedClass) {
  if (bytesLength === 0) return true
  if (familyOf(expectedClass) === 'text') return evidence.text === true
  if (expectedClass === 'docx' || expectedClass === 'xlsx') return evidence.zip === true
  return false
}

/**
 * @param {{ bytes: Uint8Array, totalByteLength: number, declaredMediaType?: string | null, filename?: string | null }} input
 */
function classifyBytes(input) {
  if (!input || !(input.bytes instanceof Uint8Array)) {
    throw new TypeError('classifyBytes requires input.bytes as a Uint8Array.')
  }
  const { bytes, totalByteLength } = input
  if (!Number.isSafeInteger(totalByteLength) || totalByteLength < bytes.length) {
    throw new TypeError(
      'classifyBytes requires totalByteLength to be an integer no smaller than bytes.length.'
    )
  }
  const mediaTypeClass = classFromMediaType(input.declaredMediaType)
  const extensionClass = classFromExtension(input.filename)
  const expectedClass = expectedClassFor(mediaTypeClass, extensionClass)
  const partial = bytes.length < totalByteLength
  const evidence = classifyFromEvidence(bytes, partial, expectedClass)

  if (
    partial &&
    bytes.length < DECLARED_EVIDENCE_PREFIX_BYTES &&
    !SIGNATURE_CLASSES.has(evidence.fileClass)
  ) {
    if (expectedClass && prefixSupportsDeclared(evidence, bytes.length, expectedClass)) {
      return result(expectedClass, 'declared', false)
    }
    if (bytes.length === 0) return result('binary_unsupported', 'declared', false)
  }

  return result(
    evidence.fileClass,
    evidence.detection,
    mismatchFor(evidence.fileClass, mediaTypeClass, extensionClass),
    evidence.zip ? ZIP_MEDIA_TYPE : undefined
  )
}

module.exports = {
  FILE_CLASSES,
  MEDIA_TYPE_BY_CLASS,
  classifyBytes,
  fileClassFamily: familyOf,
}
