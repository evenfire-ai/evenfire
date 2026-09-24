'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const { classifyBytes, FILE_CLASSES, MEDIA_TYPE_BY_CLASS } = require('./fileClassifier.cjs')

const EXPECTED_VECTOR_COUNT = 38
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
    assert.equal(result.reader, 'none')
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

describe('isomorphic module', () => {
  it('uses no Node-only API, so the renderer can load it', () => {
    const source = fs.readFileSync(path.join(__dirname, 'fileClassifier.cjs'), 'utf8')
    assert.match(source, /TextDecoder/, 'the module source was not read')
    assert.doesNotMatch(source, /\bBuffer\b/)
    assert.doesNotMatch(source, /require\(['"]node:/)
    assert.doesNotMatch(source, /require\(['"](?:crypto|fs|path|zlib)['"]\)/)
  })
})
