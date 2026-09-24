'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const { classifyBytes } = require('./fileClassifier.cjs')
const {
  FILE_REFERENCE_SCHEMA_VERSION,
  buildAttachmentFileReference,
  buildGfsFileReference,
  deriveFileReferenceId,
  parseFileReferenceV1,
} = require('./fileReference.cjs')

const EXPECTED_VECTOR_COUNT = 36
const { vectors } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'file-reference-vectors.v1.json'), 'utf8')
)
const HEX = 'b'.repeat(64)

describe('file reference vectors', () => {
  it('loads every vector', () => {
    assert.equal(vectors.length, EXPECTED_VECTOR_COUNT)
    assert.ok(vectors.some(vector => vector.expected.ok === true))
    assert.ok(vectors.some(vector => vector.expected.ok === false))
  })

  for (const vector of vectors) {
    it(vector.name, () => {
      const actual = parseFileReferenceV1(vector.input)
      assert.equal(actual.ok, vector.expected.ok, actual.ok ? 'parsed' : actual.message)
      if (vector.expected.ok) {
        assert.deepEqual(actual.value, vector.input)
      } else {
        assert.equal(actual.code, vector.expected.code)
        assert.equal(typeof actual.message, 'string')
      }
    })
  }
})

describe('deriveFileReferenceId', () => {
  it('derives attachment and gfs ids', () => {
    assert.equal(
      deriveFileReferenceId(
        { kind: 'attachment', attachmentId: 'a', messageId: 'm' },
        { algorithm: 'sha256', hex: HEX }
      ),
      `att:m:a@sha256:${HEX}`
    )
    assert.equal(
      deriveFileReferenceId({
        kind: 'gfs',
        drive: 'shared',
        resourceId: 'r',
        gfsUri: 'gfs://shared/r',
        version: 3,
      }),
      'gfs:shared:r@v3'
    )
  })

  it('requires a digest for attachments', () => {
    assert.throws(
      () => deriveFileReferenceId({ kind: 'attachment', attachmentId: 'a', messageId: 'm' }),
      TypeError
    )
  })
})

describe('builders', () => {
  const markdown = new TextEncoder().encode('# Café\n')
  const classification = classifyBytes({
    bytes: markdown,
    totalByteLength: markdown.length,
    declaredMediaType: 'text/markdown',
    filename: 'notes.md',
  })

  it('builds a valid attachment reference and normalizes the name to NFC', () => {
    const built = buildAttachmentFileReference({
      attachmentId: 'att-1',
      messageId: 'msg-1',
      name: 'café.md',
      declaredMediaType: 'text/markdown',
      byteLength: markdown.length,
      digestHex: HEX,
      classification,
    })
    assert.equal(built.ok, true, built.ok ? '' : built.message)
    assert.equal(built.value.schemaVersion, FILE_REFERENCE_SCHEMA_VERSION)
    assert.equal(built.value.name, 'café.md')
    assert.equal(built.value.id, `att:msg-1:att-1@sha256:${HEX}`)
    assert.equal(built.value.reader, 'text')
    assert.deepEqual(parseFileReferenceV1(built.value), built)
  })

  it('reports an invalid attachment name instead of throwing', () => {
    const built = buildAttachmentFileReference({
      attachmentId: 'att-1',
      messageId: 'msg-1',
      name: '../notes.md',
      byteLength: markdown.length,
      digestHex: HEX,
      classification,
    })
    assert.equal(built.ok, false)
    assert.equal(built.code, 'FILE_REFERENCE_INVALID')
  })

  it('reports an attachment digest that is not sha256 hex', () => {
    const built = buildAttachmentFileReference({
      attachmentId: 'att-1',
      messageId: 'msg-1',
      name: 'notes.md',
      byteLength: markdown.length,
      digestHex: 'not-hex',
      classification,
    })
    assert.equal(built.ok, false)
    assert.equal(built.code, 'FILE_REFERENCE_INVALID')
  })

  it('builds a gfs reference from declared metadata alone', () => {
    const declared = classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 2048,
      declaredMediaType: 'application/pdf',
      filename: 'q3.pdf',
    })
    const built = buildGfsFileReference({
      drive: 'personal',
      resourceId: 'res-42',
      gfsUri: 'gfs://personal/reports/q3.pdf',
      version: 7,
      name: 'q3.pdf',
      declaredMediaType: 'application/pdf',
      byteLength: 2048,
      classification: declared,
    })
    assert.equal(built.ok, true, built.ok ? '' : built.message)
    assert.equal(built.value.id, 'gfs:personal:res-42@v7')
    assert.equal(built.value.detection, 'declared')
    assert.equal(built.value.digest, undefined)
  })
})
