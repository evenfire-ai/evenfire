'use strict'
// Regenerates fixtures/classifier-vectors.v1.json and
// fixtures/file-reference-vectors.v1.json. Every expected output below is
// written by hand; none is computed by the classifier or the parser, so the
// vectors stay an independent statement of the contract.
//
//   node scripts/generate-vectors.cjs
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT = path.join(__dirname, '..', 'fixtures')
const b = (...parts) =>
  Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))))

function crc32(buf) {
  return zlib.crc32(buf) >>> 0
}

function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const CT = ['[Content_Types].xml', '<?xml version="1.0"?><Types/>']
const DOCX = zip([CT, ['_rels/.rels', '<Relationships/>'], ['word/document.xml', '<w:document/>']])
const XLSX = zip([CT, ['_rels/.rels', '<Relationships/>'], ['xl/workbook.xml', '<workbook/>']])
const PLAIN_ZIP = zip([['a.txt', 'hello']])
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const JPEG = b([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0x00, 0x01, 0x01, 0x00, 0xff, 0xd9])
const PNG = b(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  'IHDR',
  [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]
)
const PDF = b('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')

const T = (cls, detection, mismatch, extra = {}) => {
  const text = ['text', 'markdown', 'html', 'code', 'svg'].includes(cls)
  const media = {
    text: 'text/plain',
    markdown: 'text/markdown',
    html: 'text/html',
    code: 'text/plain',
    svg: 'image/svg+xml',
    jpeg: 'image/jpeg',
    png: 'image/png',
    pdf: 'application/pdf',
    docx: DOCX_MIME,
    xlsx: XLSX_MIME,
    binary_unsupported: 'application/octet-stream',
  }[cls]
  return {
    class: cls,
    detectedMediaType: extra.detectedMediaType ?? media,
    detection,
    textReadable: text,
    reader: text ? 'text' : 'none',
    modelImageInput: cls === 'jpeg' || cls === 'png' ? 'candidate' : 'unsupported',
    mismatch,
  }
}

const v = (name, bytes, filename, declaredMediaType, expected, totalByteLength) => ({
  name,
  input: {
    bytesBase64: Buffer.from(bytes).toString('base64'),
    totalByteLength: totalByteLength ?? bytes.length,
    declaredMediaType,
    filename,
  },
  expected,
})

const bigPrefix = Buffer.concat([Buffer.alloc(65536, 0x61), Buffer.from([0xc3])])

const classifier = [
  v('jpeg by signature', JPEG, 'photo.jpg', 'image/jpeg', T('jpeg', 'magic', false)),
  v('png by signature', PNG, 'image.png', 'image/png', T('png', 'magic', false)),
  v('png bytes named .txt', PNG, 'notes.txt', 'text/plain', T('png', 'magic', true)),
  v('pdf by signature', PDF, 'report.pdf', 'application/pdf', T('pdf', 'magic', false)),
  v(
    'pdf signature after leading bytes',
    b([0xff, 0xfe, 0xfd, 0xfc], ' '.repeat(96), PDF),
    'doc.pdf',
    null,
    T('pdf', 'magic', false)
  ),
  v(
    'text mentioning %PDF- after offset 0',
    b('A PDF file starts with %PDF-1.7 and ends with %%EOF.\n'),
    'notes.txt',
    'text/plain',
    T('text', 'text_utf8', false)
  ),
  v('pdf bytes named .txt', PDF, 'notes.txt', 'text/plain', T('pdf', 'magic', true)),
  v('docx by zip entries', DOCX, 'letter.docx', DOCX_MIME, T('docx', 'magic', false)),
  v('xlsx by zip entries', XLSX, 'sheet.xlsx', XLSX_MIME, T('xlsx', 'magic', false)),
  v(
    'plain zip archive',
    PLAIN_ZIP,
    'archive.zip',
    'application/zip',
    T('binary_unsupported', 'magic', false, { detectedMediaType: 'application/zip' })
  ),
  v(
    'zip named .docx without word entries',
    PLAIN_ZIP,
    'letter.docx',
    DOCX_MIME,
    T('binary_unsupported', 'magic', true, { detectedMediaType: 'application/zip' })
  ),
  v(
    'svg with xml declaration',
    b('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'),
    'icon.svg',
    'image/svg+xml',
    T('svg', 'text_utf8', false)
  ),
  v(
    'svg content named .txt',
    b('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'notes.txt',
    'text/plain',
    T('svg', 'text_utf8', false)
  ),
  v(
    'name .svg without svg root',
    b('not an svg at all\n'),
    'icon.svg',
    'image/svg+xml',
    T('text', 'text_utf8', false)
  ),
  v(
    'markdown with accents',
    b('# Título\n\nCafé con ñandú.\n'),
    'notes.md',
    'text/markdown',
    T('markdown', 'text_utf8', false)
  ),
  v(
    'markdown extension with text/plain',
    b('# Title\n'),
    'notes.md',
    'text/plain',
    T('markdown', 'text_utf8', false)
  ),
  v(
    'html document',
    b('<!DOCTYPE html>\n<html><body><p>hi</p></body></html>\n'),
    'page.html',
    'text/html',
    T('html', 'text_utf8', false)
  ),
  v(
    'html with inline svg stays html',
    b('<html><body><svg></svg></body></html>'),
    'page.html',
    'text/html',
    T('html', 'text_utf8', false)
  ),
  v(
    'html content named .txt',
    b('<!doctype html><html></html>'),
    'notes.txt',
    'text/plain',
    T('html', 'text_utf8', false)
  ),
  v('json code', b('{"a": 1}\n'), 'data.json', 'application/json', T('code', 'text_utf8', false)),
  v(
    'python code without media type',
    b('print("hi")\n'),
    'script.py',
    null,
    T('code', 'text_utf8', false)
  ),
  v('plain text', b('hello\n'), 'notes.txt', 'text/plain', T('text', 'text_utf8', false)),
  v(
    'text without extension or media type',
    b('plain words\r\n\tindented\n'),
    'README',
    null,
    T('text', 'text_utf8', false)
  ),
  v(
    'utf-8 byte order mark',
    b([0xef, 0xbb, 0xbf], 'hola\n'),
    'notes.txt',
    'text/plain',
    T('text', 'text_utf8', false)
  ),
  v(
    'utf-16le with byte order mark',
    b([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]),
    'notes.txt',
    'text/plain',
    T('binary_unsupported', 'magic', true)
  ),
  v(
    'embedded NUL',
    b('abc', [0x00], 'def'),
    'data.txt',
    'text/plain',
    T('binary_unsupported', 'magic', true)
  ),
  v(
    'C1 control character',
    b('a', [0xc2, 0x85], 'b'),
    'data.txt',
    'text/plain',
    T('binary_unsupported', 'magic', true)
  ),
  v('invalid utf-8', b([0x61, 0xc3, 0x28]), 'x.txt', null, T('binary_unsupported', 'magic', true)),
  v('empty text file', b(''), 'empty.txt', 'text/plain', T('text', 'text_utf8', false)),
  v(
    'arbitrary binary',
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    'data.bin',
    'application/octet-stream',
    T('binary_unsupported', 'magic', false)
  ),
  v(
    'gif is not a supported image',
    b('GIF89a', [0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    'anim.gif',
    'image/gif',
    T('binary_unsupported', 'magic', false)
  ),
  v(
    'empty prefix falls back to the declared pdf',
    b(''),
    'report.pdf',
    'application/pdf',
    T('pdf', 'declared', false),
    1000
  ),
  v(
    'empty prefix without declaration',
    b(''),
    'blob',
    null,
    T('binary_unsupported', 'declared', false),
    500
  ),
  v(
    'short text prefix keeps the declared markdown',
    b('# Title\n'),
    'notes.md',
    'text/markdown',
    T('markdown', 'declared', false),
    100000
  ),
  v(
    'short zip prefix keeps the declared docx',
    DOCX.subarray(0, 80),
    'letter.docx',
    DOCX_MIME,
    T('docx', 'declared', false),
    DOCX.length
  ),
  v(
    'short prefix with jpeg signature overrides a pdf declaration',
    JPEG,
    'report.pdf',
    'application/pdf',
    T('jpeg', 'magic', true),
    5000
  ),
  v(
    'short binary prefix contradicts a text declaration',
    b('ab', [0x00, 0x01]),
    'a.txt',
    'text/plain',
    T('binary_unsupported', 'magic', true),
    10000
  ),
  v(
    'long text prefix ending mid-sequence',
    bigPrefix,
    'big.txt',
    'text/plain',
    T('text', 'text_utf8', false),
    70000
  ),
]

const HEX = 'a'.repeat(64)
const attachmentBase = {
  schemaVersion: 1,
  id: `att:msg-1:att-1@sha256:${HEX}`,
  source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' },
  name: 'notes.md',
  declaredMediaType: 'text/markdown',
  detectedMediaType: 'text/markdown',
  class: 'markdown',
  detection: 'text_utf8',
  mismatch: false,
  byteLength: 12,
  digest: { algorithm: 'sha256', hex: HEX },
  textReadable: true,
  reader: 'text',
  modelImageInput: 'unsupported',
}
const RID = '3f2a9c1e7b4d4e0a9c8b6d5e4f3a2b1c'
const DASHED_RID = '3F2A9C1E-7B4D-4E0A-9C8B-6D5E4F3A2B1C'
const gfsBase = {
  schemaVersion: 1,
  id: `gfs:personal:${RID}@v7`,
  source: {
    kind: 'gfs',
    drive: 'personal',
    resourceId: RID,
    gfsUri: `gfs://personal/${RID}`,
    version: 7,
  },
  name: 'q3.pdf',
  declaredMediaType: 'application/pdf',
  detectedMediaType: 'application/pdf',
  class: 'pdf',
  detection: 'declared',
  mismatch: false,
  byteLength: 2048,
  textReadable: false,
  reader: 'none',
  modelImageInput: 'unsupported',
}
const ok = { ok: true }
const invalid = { ok: false, code: 'FILE_REFERENCE_INVALID' }
const unsupported = { ok: false, code: 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED' }
const r = (name, input, expected) => ({ name, input, expected })
const without = (object, key) => {
  const copy = { ...object }
  delete copy[key]
  return copy
}

const references = [
  r('valid attachment reference', attachmentBase, ok),
  r('valid gfs reference without digest', gfsBase, ok),
  r(
    'valid gfs reference with digest',
    { ...gfsBase, digest: { algorithm: 'sha256', hex: HEX } },
    ok
  ),
  r(
    'binary_unsupported may carry application/zip',
    {
      ...attachmentBase,
      class: 'binary_unsupported',
      detectedMediaType: 'application/zip',
      detection: 'magic',
      textReadable: false,
      reader: 'none',
      mismatch: true,
    },
    ok
  ),
  r(
    'png attachment is an image input candidate',
    {
      ...attachmentBase,
      class: 'png',
      detectedMediaType: 'image/png',
      detection: 'magic',
      textReadable: false,
      reader: 'none',
      modelImageInput: 'candidate',
    },
    ok
  ),
  r('name of 255 code points', { ...attachmentBase, name: `${'ñ'.repeat(252)}.md` }, ok),
  r('missing schemaVersion', without(attachmentBase, 'schemaVersion'), unsupported),
  r('schemaVersion 2', { ...attachmentBase, schemaVersion: 2 }, unsupported),
  r('schemaVersion as a string', { ...attachmentBase, schemaVersion: '1' }, unsupported),
  r('not an object', 'att:msg-1:att-1', invalid),
  r('forged id', { ...attachmentBase, id: 'att:msg-1:att-2@sha256:' + HEX }, invalid),
  r('gfs id with the wrong version', { ...gfsBase, id: `gfs:personal:${RID}@v6` }, invalid),
  r(
    'gfs resourceId with dashes and a normalized gfsUri',
    {
      ...gfsBase,
      source: { ...gfsBase.source, resourceId: DASHED_RID },
      id: `gfs:personal:${DASHED_RID}@v7`,
    },
    ok
  ),
  r(
    'gfs resourceId that is not 32 hex digits',
    {
      ...gfsBase,
      source: { ...gfsBase.source, resourceId: 'res-42', gfsUri: 'gfs://personal/res-42' },
      id: 'gfs:personal:res-42@v7',
    },
    invalid
  ),
  r(
    'gfsUri naming another resource',
    { ...gfsBase, source: { ...gfsBase.source, gfsUri: `gfs://personal/${'b'.repeat(32)}` } },
    invalid
  ),
  r(
    'gfsUri on another drive',
    { ...gfsBase, source: { ...gfsBase.source, gfsUri: `gfs://shared/${RID}` } },
    invalid
  ),
  r(
    'gfsUri with the dashed resourceId',
    {
      ...gfsBase,
      source: { ...gfsBase.source, resourceId: DASHED_RID, gfsUri: `gfs://personal/${DASHED_RID}` },
      id: `gfs:personal:${DASHED_RID}@v7`,
    },
    invalid
  ),
  r('attachment without digest', without(attachmentBase, 'digest'), invalid),
  r(
    'uppercase digest',
    {
      ...attachmentBase,
      digest: { algorithm: 'sha256', hex: 'A'.repeat(64) },
      id: `att:msg-1:att-1@sha256:${'A'.repeat(64)}`,
    },
    invalid
  ),
  r(
    'digest algorithm other than sha256',
    { ...attachmentBase, digest: { algorithm: 'md5', hex: HEX } },
    invalid
  ),
  r('name with a slash', { ...attachmentBase, name: 'dir/notes.md' }, invalid),
  r('name with a backslash', { ...attachmentBase, name: 'dir\\notes.md' }, ok),
  r('name ..', { ...attachmentBase, name: '..' }, invalid),
  r('name with a control character', { ...attachmentBase, name: 'notes\u0007.md' }, invalid),
  r('name not in NFC', { ...attachmentBase, name: 'café.md' }, invalid),
  r('name of 256 code points', { ...attachmentBase, name: `${'ñ'.repeat(253)}.md` }, invalid),
  r('empty name', { ...attachmentBase, name: '' }, invalid),
  r('reader text on a pdf', { ...gfsBase, reader: 'text' }, invalid),
  r('textReadable on a pdf', { ...gfsBase, textReadable: true, reader: 'text' }, invalid),
  r('image candidate on a pdf', { ...gfsBase, modelImageInput: 'candidate' }, invalid),
  r('text detection on a pdf', { ...gfsBase, detection: 'text_utf8' }, invalid),
  r(
    'detected media type contradicts class',
    { ...gfsBase, detectedMediaType: 'text/plain' },
    invalid
  ),
  r('unknown class', { ...gfsBase, class: 'gif' }, invalid),
  r('unknown top-level field', { ...attachmentBase, preview: 'data:...' }, invalid),
  r(
    'unknown source field',
    { ...attachmentBase, source: { ...attachmentBase.source, path: '/tmp/x' } },
    invalid
  ),
  r(
    'unknown source kind',
    { ...attachmentBase, source: { kind: 'tool', toolCallId: 't-1' } },
    invalid
  ),
  r(
    'negative gfs version',
    { ...gfsBase, source: { ...gfsBase.source, version: -1 }, id: `gfs:personal:${RID}@v-1` },
    invalid
  ),
  r(
    'fractional gfs version',
    { ...gfsBase, source: { ...gfsBase.source, version: 1.5 }, id: `gfs:personal:${RID}@v1.5` },
    invalid
  ),
  r('negative byteLength', { ...attachmentBase, byteLength: -1 }, invalid),
  r('empty declared media type', { ...attachmentBase, declaredMediaType: '' }, invalid),
  r('mismatch not boolean', { ...attachmentBase, mismatch: 'no' }, invalid),
]

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(
  path.join(OUT, 'classifier-vectors.v1.json'),
  JSON.stringify({ schemaVersion: 1, vectors: classifier }, null, 2) + '\n'
)
fs.writeFileSync(
  path.join(OUT, 'file-reference-vectors.v1.json'),
  JSON.stringify({ schemaVersion: 1, vectors: references }, null, 2) + '\n'
)
console.log(`classifier=${classifier.length} references=${references.length}`)
