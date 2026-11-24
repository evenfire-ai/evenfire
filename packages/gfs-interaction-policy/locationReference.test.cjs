'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const {
  LOCATION_REFERENCE_MAX_COUNT,
  LOCATION_REFERENCE_SCHEMA_VERSION,
  buildGfsLocationReference,
  deriveLocationReferenceId,
  parseLocationReferenceV1,
} = require('./locationReference.cjs')
const policy = require('./index.cjs')

const EXPECTED_VECTOR_COUNT = 26
const { vectors } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'location-reference-vectors.v1.json'), 'utf8')
)
const RID = 'c'.repeat(32)

describe('location reference vectors', () => {
  it('loads every vector', () => {
    assert.equal(vectors.length, EXPECTED_VECTOR_COUNT)
    assert.ok(vectors.some(vector => vector.expected.ok === true))
    assert.ok(vectors.some(vector => vector.expected.ok === false))
  })

  for (const vector of vectors) {
    it(vector.name, () => {
      const actual = parseLocationReferenceV1(vector.input)
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

describe('LocationReferenceV1 limits and ids', () => {
  it('allows one folder per message and shares the FileReference schema version', () => {
    assert.equal(LOCATION_REFERENCE_MAX_COUNT, 1)
    assert.equal(LOCATION_REFERENCE_SCHEMA_VERSION, 1)
  })

  it('derives the id from drive and resourceId', () => {
    assert.equal(
      deriveLocationReferenceId({
        kind: 'gfs',
        drive: 'team',
        resourceId: RID,
        gfsUri: `gfs://team/${RID}`,
      }),
      `gfs-folder:team:${RID}`
    )
    assert.throws(() => deriveLocationReferenceId({ kind: 'attachment' }), TypeError)
  })

  it('is exported from the package index', () => {
    assert.equal(policy.parseLocationReferenceV1, parseLocationReferenceV1)
    assert.equal(policy.LOCATION_REFERENCE_MAX_COUNT, 1)
  })
})

describe('buildGfsLocationReference', () => {
  it('builds a reference that parses back to itself, with the name in NFC', () => {
    const built = buildGfsLocationReference({
      drive: 'team',
      resourceId: RID,
      gfsUri: `gfs://team/${RID}`,
      name: 'Café',
    })
    assert.equal(built.ok, true, built.ok ? '' : built.message)
    assert.equal(built.value.name, 'Café')
    assert.equal(built.value.id, `gfs-folder:team:${RID}`)
    assert.deepEqual(parseLocationReferenceV1(built.value), built)
  })

  it('reports an invalid source or name instead of throwing', () => {
    for (const fields of [
      { drive: 'team', resourceId: RID, gfsUri: `gfs://other/${RID}`, name: 'Reports' },
      { drive: 'team', resourceId: 'x', gfsUri: 'gfs://team/x', name: 'Reports' },
      { drive: 'team', resourceId: RID, gfsUri: `gfs://team/${RID}`, name: 'a/b' },
    ]) {
      const built = buildGfsLocationReference(fields)
      assert.equal(built.ok, false)
      assert.equal(built.code, 'FILE_REFERENCE_INVALID')
    }
  })
})
