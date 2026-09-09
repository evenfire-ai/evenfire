'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const policy = require('./index.cjs')
const {
  GFS_RESOURCE_NAME_MAX_LENGTH,
  createGfsUploadNameReservationBook,
  gfsUploadNameRetryDecision,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
  normalizeGfsResourceName,
} = policy

it('keeps runtime exports aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    match => match[1]
  ).sort()
  assert.deepEqual(Object.keys(policy).sort(), declared)
})

describe('GFS collision classification and retry policy', () => {
  it('classifies the structured error emitted by the Control UI Upload v2 producer', () => {
    const error = Object.assign(new Error('409 resource already exists'), {
      status: 409,
      code: 'conflict',
    })
    assert.equal(isGfsNameConflict(error), true)
    assert.equal(gfsUploadNameRetryDecision(error, { attempt: 0 }), 'retry')
  })

  it('keeps the legacy Electron conflict string as an explicit compatibility case', () => {
    const error = new Error(
      "Error invoking remote method 'gfs:createFileFromPath': Error: 409 Conflict: [object Object]"
    )
    assert.equal(isGfsNameConflict(error), true)
  })

  it('refuses name retries for unrelated errors, resume sessions, and exhaustion', () => {
    const conflict = Object.assign(new Error('409 resource already exists'), { status: 409 })
    assert.equal(
      gfsUploadNameRetryDecision(new Error('network failed'), { attempt: 0 }),
      'terminal'
    )
    assert.equal(gfsUploadNameRetryDecision(conflict, { attempt: 0, resuming: true }), 'terminal')
    assert.equal(gfsUploadNameRetryDecision(conflict, { attempt: 1, retryLimit: 2 }), 'exhausted')
  })

  it('does not let compatibility text override an authoritative non-409 status', () => {
    const error = Object.assign(new Error('403 resource already exists outside your access'), {
      status: 403,
      code: 'forbidden',
    })
    assert.equal(isGfsNameConflict(error), false)
  })
})

describe('GFS resource naming', () => {
  it('selects the first numbered gap while preserving the extension', () => {
    assert.equal(
      nextAvailableGfsResourceName('report.txt', [
        'report.txt',
        'report (1).txt',
        'report (3).txt',
      ]),
      'report (2).txt'
    )
  })

  it('normalizes long names deterministically within the 255-character limit', async () => {
    const name = `${'a'.repeat(280)}.txt`
    const normalized = await normalizeGfsResourceName(name)
    assert.equal(normalized.length, GFS_RESOURCE_NAME_MAX_LENGTH)
    assert.match(normalized, /-[0-9a-f]{12}\.txt$/)
  })

  it('rejects path separators and control characters before allocation', async () => {
    await assert.rejects(() => normalizeGfsResourceName('../report.txt'), /path separators/)
    await assert.rejects(() => normalizeGfsResourceName('report\n.txt'), /control characters/)
  })
})

describe('GFS upload name reservations', () => {
  it('allocates distinct concurrent names in one parent and isolates other parents', () => {
    const book = createGfsUploadNameReservationBook()
    const occupied = new Set()
    const first = book.begin('parent-a', 'report.txt', occupied)
    const second = book.begin('parent-a', 'report.txt', occupied)
    const otherParent = book.begin('parent-b', 'report.txt', new Set())

    assert.equal(first.reserveNext(), 'report.txt')
    assert.equal(second.reserveNext(), 'report (1).txt')
    assert.equal(otherParent.reserveNext(), 'report.txt')
    assert.deepEqual(book.reservedNames('parent-a'), ['report.txt', 'report (1).txt'])

    first.release()
    second.release()
    otherParent.release()
    assert.deepEqual(book.reservedNames('parent-a'), [])
    assert.deepEqual(book.reservedNames('parent-b'), [])
  })

  it('retains retry candidates until settlement and releases all after success', () => {
    const book = createGfsUploadNameReservationBook()
    const occupied = new Set()
    const operation = book.begin('parent', 'report.txt', occupied)
    const first = operation.reserveNext()
    operation.markConflict(first)
    const second = operation.reserveNext()
    operation.markSuccess(second)

    assert.equal(second, 'report (1).txt')
    assert.deepEqual(book.reservedNames('parent'), ['report.txt', 'report (1).txt'])
    operation.release()
    assert.deepEqual(book.reservedNames('parent'), [])
  })

  it('releases failure reservations without dropping another operation reference', () => {
    const book = createGfsUploadNameReservationBook()
    const first = book.begin('parent', 'report.txt', new Set())
    const resume = book.begin('parent', 'report.txt', new Set())
    first.reserveNext({ exact: true })
    resume.reserveNext({ exact: true })

    first.release()
    assert.deepEqual(book.reservedNames('parent'), ['report.txt'])
    resume.release()
    assert.deepEqual(book.reservedNames('parent'), [])
  })
})
