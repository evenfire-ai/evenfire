'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const { classifyBytes, FILE_CLASSES, MEDIA_TYPE_BY_CLASS } = require('./fileClassifier.cjs')

const EXPECTED_VECTOR_COUNT = 48
const { vectors } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'classifier-vectors.v1.json'), 'utf8')
)

function bytesOf(vector) {
  return new Uint8Array(Buffer.from(vector.input.bytesBase64, 'base64'))
}

describe('classifier vectors', () => {
  it('loads every vector', () => {
    assert.equal(vectors.length, EXPECTED_VECTOR_COUNT)
  })

  for (const vector of vectors) {
    it(vector.name, () => {
      const actual = classifyBytes({
        bytes: bytesOf(vector),
        totalByteLength: vector.input.totalByteLength,
        declaredMediaType: vector.input.declaredMediaType,
        filename: vector.input.filename,
      })
      assert.deepEqual(actual, vector.expected)
    })
  }

  it('covers every file class and every detection', () => {
    const classes = new Set(vectors.map(vector => vector.expected.class))
    assert.deepEqual([...classes].sort(), [...FILE_CLASSES].sort())
    const detections = new Set(vectors.map(vector => vector.expected.detection))
    assert.deepEqual([...detections].sort(), ['declared', 'magic', 'text_utf8'])
  })
})

describe('classifyBytes', () => {
  it('maps every class to a detected media type', () => {
    for (const fileClass of FILE_CLASSES)
      assert.equal(typeof MEDIA_TYPE_BY_CLASS[fileClass], 'string')
  })

  it('rejects input that is not a Uint8Array', () => {
    assert.throws(() => classifyBytes({ bytes: 'abc', totalByteLength: 3 }), TypeError)
  })

  it('rejects a total length smaller than the bytes provided', () => {
    assert.throws(
      () => classifyBytes({ bytes: new Uint8Array([1, 2, 3]), totalByteLength: 2 }),
      TypeError
    )
  })

  it('does not decode a binary file as text', () => {
    const result = classifyBytes({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]),
      totalByteLength: 7,
      filename: 'x.txt',
    })
    assert.equal(result.class, 'pdf')
    assert.equal(result.textReadable, false)
    assert.equal(result.reader, 'pdf')
  })

  it('ignores media type parameters and case', () => {
    const result = classifyBytes({
      bytes: new TextEncoder().encode('# T\n'),
      totalByteLength: 4,
      declaredMediaType: 'Text/Markdown; charset=UTF-8',
      filename: null,
    })
    assert.equal(result.class, 'markdown')
    assert.equal(result.mismatch, false)
  })
})

describe('a password-protected workbook', () => {
  // Made once with msoffcrypto-tool from a one-sheet ExcelJS workbook
  // (password "fixture-password"). It is a CFB container, not a zip.
  const encrypted = new Uint8Array(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'encrypted-workbook.xlsx'))
  )
  const classify = (bytes, filename, declaredMediaType) =>
    classifyBytes({ bytes, totalByteLength: bytes.length, declaredMediaType, filename })

  it('is a real CFB file holding both encryption streams', () => {
    assert.deepEqual(
      [...encrypted.subarray(0, 8)],
      [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    )
    const text = Buffer.from(encrypted).toString('utf16le')
    assert.ok(text.includes('EncryptionInfo'))
    assert.ok(text.includes('EncryptedPackage'))
  })

  it('reaches the xlsx reader when declared as a workbook', () => {
    const result = classify(encrypted, 'locked.xlsx', MEDIA_TYPE_BY_CLASS.xlsx)
    assert.equal(result.class, 'xlsx')
    assert.equal(result.reader, 'xlsx')
    assert.equal(result.detection, 'magic')
    assert.equal(result.mismatch, false)
  })

  it('stays unsupported without a declaration', () => {
    const result = classify(encrypted, null, null)
    assert.equal(result.class, 'binary_unsupported')
    assert.equal(result.reader, 'none')
  })

  it('stays unsupported with a mismatch once the encryption stream is gone', () => {
    const marker = Buffer.from('EncryptedPackage', 'utf16le')
    const altered = Buffer.from(encrypted)
    // The name appears in the directory entry and in the DataSpaces map.
    let replaced = 0
    for (let at = altered.indexOf(marker); at >= 0; at = altered.indexOf(marker, at + 1)) {
      Buffer.from('OrdinaryPackage!', 'utf16le').copy(altered, at)
      replaced += 1
    }
    assert.ok(replaced > 0, 'the fixture holds the EncryptedPackage stream name')
    const result = classify(new Uint8Array(altered), 'locked.xlsx', MEDIA_TYPE_BY_CLASS.xlsx)
    assert.equal(result.class, 'binary_unsupported')
    assert.equal(result.mismatch, true)
  })

  it('leaves an unencrypted workbook classified by its zip entries', () => {
    const plain = vectors.find(vector => vector.name === 'xlsx by zip entries')
    const result = classify(bytesOf(plain), 'sheet.xlsx', MEDIA_TYPE_BY_CLASS.xlsx)
    assert.equal(result.class, 'xlsx')
    assert.equal(result.detection, 'magic')
  })
})

describe('isomorphic module', () => {
  // The renderer loads all three modules (index.cjs re-exports the other two).
  for (const file of ['fileClassifier.cjs', 'fileReference.cjs', 'index.cjs']) {
    it(`${file} uses no Node-only API, so the renderer can load it`, () => {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
      assert.match(source, /module\.exports/, `the ${file} source was not read`)
      assert.doesNotMatch(source, /\bBuffer\b/)
      assert.doesNotMatch(source, /require\(['"]node:/)
      assert.doesNotMatch(source, /require\(['"](?:crypto|fs|path|zlib)['"]\)/)
    })
  }
})
