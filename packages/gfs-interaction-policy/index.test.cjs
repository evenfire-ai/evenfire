'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const policy = require('./index.cjs')
const {
  GFS_RESOURCE_NAME_MAX_LENGTH,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  createGfsUploadNameReservationBook,
  gfsUploadNameRetryDecision,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
  normalizeGfsResourceName,
} = policy

const PROPERTY_RUNS = 200
const PROPERTY_SEED = 0x5eed_2026

function createSeededRandom(seed) {
  let state = seed >>> 0 || 0x6d2b_79f5
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function randomInteger(random, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(random() * (maxInclusive - minInclusive + 1))
}

function randomElement(random, values) {
  return values[randomInteger(random, 0, values.length - 1)]
}

function shuffled(random, values) {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInteger(random, 0, index)
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

const PROPERTY_BASES = ['report', 'notes', 'agenda', 'scan', 'export', 'café', 'данные']
const PROPERTY_EXTENSIONS = ['.txt', '.md', '.json', '.tar.gz', '']

function randomResourceName(random) {
  const suffixCount = randomInteger(random, 0, 2)
  const suffix = `-${randomInteger(random, 1, 9)}`.repeat(suffixCount)
  return `${randomElement(random, PROPERTY_BASES)}${suffix}${randomElement(random, PROPERTY_EXTENSIONS)}`
}

function extensionOf(name) {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) return ''
  return name.slice(lastDot)
}

function splitBase(name) {
  const extension = extensionOf(name)
  return extension ? name.slice(0, -extension.length) : name
}

function assertIsValidAllocation(allocated, requestedName, occupiedNames) {
  const normalized = requestedName.normalize('NFC')
  const base = splitBase(normalized)
  const extension = extensionOf(normalized)
  const occupied = new Set(Array.from(occupiedNames, value => value.normalize('NFC')))
  assert.ok(allocated.length <= GFS_RESOURCE_NAME_MAX_LENGTH, `over limit: ${allocated}`)
  assert.equal(allocated, allocated.normalize('NFC'))
  assert.ok(!/[\/\\\u0000-\u001f\u007f]/.test(allocated))
  assert.ok(!occupied.has(allocated), `allocated occupied name: ${allocated}`)
  if (extension) {
    assert.ok(allocated.endsWith(extension), `extension lost: ${allocated}`)
    const allocatedBase = allocated.slice(0, -extension.length)
    assert.ok(
      allocatedBase === base ||
        (allocatedBase.startsWith(base) && /^ \(\d+\)$/.test(allocatedBase.slice(base.length))),
      `unexpected base: ${allocated}`
    )
    const numberMatch = allocatedBase.match(/ \((\d+)\)$/)
    if (numberMatch) {
      const claimed = Number(numberMatch[1])
      assert.ok(Number.isInteger(claimed) && claimed >= 1, `invalid number: ${allocated}`)
      for (let candidate = 1; candidate < claimed; candidate += 1) {
        assert.ok(
          occupied.has(`${base} (${candidate})${extension}`),
          `skipped free gap ${candidate}: ${allocated}`
        )
      }
    }
  } else {
    assert.ok(!allocated.includes('.'), `introduced a dot: ${allocated}`)
    assert.ok(
      allocated === normalized || /^ \(\d+\)$/.test(allocated.slice(normalized.length)),
      `unexpected suffix: ${allocated}`
    )
  }
}

function randomOccupiedNames(random, requestedName) {
  const occupied = new Set()
  if (random() < 0.25) occupied.add(requestedName.normalize('NFC'))
  const base = splitBase(requestedName.normalize('NFC'))
  const extension = extensionOf(requestedName)
  const gapCount = randomInteger(random, 0, 5)
  let previous = 0
  for (let index = 0; index < gapCount; index += 1) {
    previous += randomInteger(random, 1, 3)
    occupied.add(`${base} (${previous})${extension}`)
  }
  const noiseCount = randomInteger(random, 0, 3)
  for (let index = 0; index < noiseCount; index += 1) occupied.add(randomResourceName(random))
  return occupied
}

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

function randomConflictError(random) {
  switch (randomInteger(random, 0, 2)) {
    case 0:
      return Object.assign(new Error('409 resource already exists'), {
        status: 409,
        code: 'conflict',
      })
    case 1:
      return Object.assign(new Error('conflict'), {
        code: randomElement(random, [
          'conflict',
          'already_exists',
          'duplicate',
          'name_conflict',
          'resource_exists',
        ]),
      })
    default:
      return new Error(
        "Error invoking remote method 'gfs:createFileFromPath': Error: 409 Conflict: [object Object]"
      )
  }
}

const BENIGN_MESSAGES = [
  'upload failed',
  'session rejected',
  'payload too large',
  'write error',
  'quota exceeded',
  'tier limit reached',
]

describe('GFS collision policy invariants (property-based)', () => {
  it('allocation validity: generated collision names stay valid and unoccupied', () => {
    const random = createSeededRandom(PROPERTY_SEED)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const requested = randomResourceName(random)
      const inputForm = random() < 0.3 ? requested.normalize('NFD') : requested
      const occupied = randomOccupiedNames(random, requested)
      const allocated = nextAvailableGfsResourceName(inputForm, occupied)
      assertIsValidAllocation(allocated, requested, occupied)
    }
  })

  it('allocation validity: long requested names never exceed the resource-name limit', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x10)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const extension = randomElement(
        random,
        PROPERTY_EXTENSIONS.filter(value => value !== '')
      )
      const requested = `${'a'.repeat(randomInteger(random, 180, 240 - extension.length))}${extension}`
      const occupied = randomOccupiedNames(random, requested)
      const allocated = nextAvailableGfsResourceName(requested, occupied)
      assertIsValidAllocation(allocated, requested, occupied)
      assert.ok(allocated.length <= GFS_RESOURCE_NAME_MAX_LENGTH)
    }
  })

  it('bounded retry: attempts stay monotonic and never exceed the configured limit', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x20)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const conflict = randomConflictError(random)
      const retryLimit = randomInteger(random, 1, 12)
      const decisions = []
      let attempt = 0
      let decision = gfsUploadNameRetryDecision(conflict, { attempt, retryLimit })
      decisions.push(decision)
      while (decision === 'retry') {
        attempt += 1
        assert.ok(attempt < retryLimit, 'retry attempt exceeded the configured limit')
        decision = gfsUploadNameRetryDecision(conflict, { attempt, retryLimit })
        decisions.push(decision)
      }
      assert.equal(decision, 'exhausted')
      assert.equal(attempt, retryLimit - 1)
      assert.deepEqual(decisions, [...Array(decisions.length - 1).fill('retry'), 'exhausted'])
      assert.equal(
        gfsUploadNameRetryDecision(conflict, { attempt: retryLimit, retryLimit }),
        'exhausted'
      )
      assert.equal(
        gfsUploadNameRetryDecision(conflict, {
          attempt: retryLimit + randomInteger(random, 0, 50),
          retryLimit,
        }),
        'exhausted'
      )
      assert.equal(
        gfsUploadNameRetryDecision(new Error('network failed'), { attempt: 0, retryLimit }),
        'terminal'
      )
      assert.equal(
        gfsUploadNameRetryDecision(conflict, { attempt: 0, retryLimit, resuming: true }),
        'terminal'
      )
    }
    const conflict = randomConflictError(createSeededRandom(PROPERTY_SEED ^ 0x21))
    assert.equal(
      gfsUploadNameRetryDecision(conflict, { attempt: GFS_UPLOAD_NAME_RETRY_LIMIT - 1 }),
      'exhausted'
    )
    assert.equal(
      gfsUploadNameRetryDecision(conflict, { attempt: GFS_UPLOAD_NAME_RETRY_LIMIT - 2 }),
      'retry'
    )
    assert.throws(() => gfsUploadNameRetryDecision(conflict, { attempt: -1 }))
    assert.throws(() => gfsUploadNameRetryDecision(conflict, { attempt: 0.5 }))
    assert.throws(() => gfsUploadNameRetryDecision(conflict, { attempt: 0, retryLimit: 0 }))
    assert.throws(() => gfsUploadNameRetryDecision(conflict, { attempt: 0, retryLimit: 1.5 }))
  })

  it('parent isolation: reservations and collisions under one parent never affect another', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x30)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const book = createGfsUploadNameReservationBook()
      const requested = randomResourceName(random)
      const normalized = requested.normalize('NFC')
      const base = splitBase(normalized)
      const extension = extensionOf(normalized)
      const firstNumbered = `${base} (1)${extension}`
      const occupiedA = new Set([normalized])
      const gapCount = randomInteger(random, 0, 4)
      let previous = 0
      for (let index = 0; index < gapCount; index += 1) {
        previous += randomInteger(random, 1, 3)
        occupiedA.add(`${base} (${previous})${extension}`)
      }
      const occupiedB = new Set()
      while (occupiedB.size < randomInteger(random, 0, 3)) {
        const noise = randomResourceName(random)
        if (noise.normalize('NFC') !== normalized && noise.normalize('NFC') !== firstNumbered) {
          occupiedB.add(noise.normalize('NFC'))
        }
      }

      const firstA = book.begin('parent-a', requested, occupiedA)
      const firstB = book.begin('parent-b', requested, occupiedB)
      const allocatedA = firstA.reserveNext()
      assert.ok(allocatedA !== normalized, 'parent A must start on a numbered name')
      assert.equal(firstB.reserveNext(), normalized)

      firstA.markConflict(allocatedA)
      const secondA = book.begin('parent-a', requested, occupiedA)
      const retriedA = secondA.reserveNext()
      assertIsValidAllocation(retriedA, requested, [...occupiedA, normalized])
      assert.notEqual(retriedA, allocatedA)

      const secondB = book.begin('parent-b', requested, occupiedB)
      assert.equal(secondB.reserveNext(), firstNumbered)
      assert.ok(!book.reservedNames('parent-b').includes(retriedA))
      assert.ok(!book.reservedNames('parent-a').includes(normalized))

      firstA.release()
      secondA.release()
      firstB.release()
      secondB.release()
      assert.deepEqual(book.reservedNames('parent-a'), [])
      assert.deepEqual(book.reservedNames('parent-b'), [])
    }
  })

  it('reference counts: repeated reservations and releases preserve the remaining count', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x40)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const book = createGfsUploadNameReservationBook()
      const requested = randomResourceName(random)
      const normalized = requested.normalize('NFC')
      const holders = Array.from({ length: randomInteger(random, 1, 6) }, () =>
        book.begin('parent', requested, new Set())
      )
      for (const holder of holders) holder.reserveNext({ exact: true })
      assert.deepEqual(book.reservedNames('parent'), [normalized])

      const releaseOrder = shuffled(random, holders)
      for (let index = 0; index < releaseOrder.length - 1; index += 1) {
        releaseOrder[index].release()
        assert.deepEqual(book.reservedNames('parent'), [normalized])
        const newcomer = book.begin('parent', requested, new Set())
        assert.notEqual(newcomer.reserveNext(), normalized)
        newcomer.release()
      }
      releaseOrder[releaseOrder.length - 1].release()
      assert.deepEqual(book.reservedNames('parent'), [])
    }
  })

  it('idempotent release: settling twice or never having reserved does not corrupt state', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x50)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const book = createGfsUploadNameReservationBook()
      const requested = randomResourceName(random)
      const occupied = new Set()
      const witness = book.begin('parent', randomResourceName(random), new Set())
      const witnessName = witness.reserveNext()

      const empty = book.begin('parent', requested, occupied)
      empty.release()
      empty.release()

      const holder = book.begin('parent', requested, occupied)
      const name = holder.reserveNext()
      holder.markConflict(name)
      holder.release()
      const before = [...book.reservedNames('parent')].sort()
      holder.release()
      assert.deepEqual([...book.reservedNames('parent')].sort(), before)
      assert.ok(book.reservedNames('parent').includes(witnessName))
      assert.throws(() => holder.reserveNext(), /already settled/)

      witness.release()
      assert.deepEqual(book.reservedNames('parent'), [])
    }
  })

  it('cleanup: success, retry exhaustion, and failure paths leak no reservations', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x60)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const book = createGfsUploadNameReservationBook()
      const occupied = new Set()
      const bystander = book.begin('parent', randomResourceName(random), occupied)
      const bystanderName = bystander.reserveNext()

      const success = book.begin('parent', randomResourceName(random), occupied)
      const successName = success.reserveNext()
      success.markSuccess(successName)
      success.release()

      const failure = book.begin('parent', randomResourceName(random), occupied)
      failure.reserveNext()
      failure.release()
      failure.release()

      const exhausted = book.begin('parent', randomResourceName(random), occupied)
      const retryLimit = randomInteger(random, 1, 6)
      const conflict = randomConflictError(random)
      const candidates = []
      for (let attempt = 0; ; attempt += 1) {
        const candidate = exhausted.reserveNext()
        assert.ok(!candidates.includes(candidate), 'retry reselected a conflicted candidate')
        candidates.push(candidate)
        exhausted.markConflict(candidate)
        if (gfsUploadNameRetryDecision(conflict, { attempt, retryLimit }) !== 'retry') break
      }
      assert.ok(candidates.length <= retryLimit)
      exhausted.release()

      assert.deepEqual([...book.reservedNames('parent')].sort(), [bystanderName].sort())
      bystander.release()
      assert.deepEqual(book.reservedNames('parent'), [])
      assert.deepEqual(book.reservedNames('unrelated-parent'), [])
    }
  })

  it('reservation lifecycle: random operation mixes match the reference model exactly', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x70)
    for (let run = 0; run < PROPERTY_RUNS / 4; run += 1) {
      const book = createGfsUploadNameReservationBook()
      const parents = ['parent-a', 'parent-b', 'parent-c']
      const occupiedByParent = new Map(parents.map(parent => [parent, new Set()]))
      const model = new Map(parents.map(parent => [parent, new Map()]))
      const live = []
      const settled = []

      const assertModelMatches = () => {
        for (const parent of parents) {
          const expected = [...model.get(parent).entries()]
            .filter(([, count]) => count > 0)
            .map(([name]) => name)
            .sort()
          assert.deepEqual([...book.reservedNames(parent)].sort(), expected)
        }
      }

      const releaseEntry = entry => {
        const counts = model.get(entry.parent)
        for (const name of entry.attempts) {
          const remaining = (counts.get(name) ?? 0) - 1
          if (remaining > 0) counts.set(name, remaining)
          else counts.delete(name)
        }
        entry.operation.release()
      }

      for (let step = 0; step < 40; step += 1) {
        const action = randomElement(random, [
          'begin',
          'reserve',
          'reserve-exact',
          'conflict',
          'success',
          'release',
          're-release',
          'settled-reserve',
        ])

        if (action === 'begin' || live.length === 0) {
          const parent = randomElement(random, parents)
          const requested = randomResourceName(random)
          live.push({
            parent,
            requested,
            operation: book.begin(parent, requested, occupiedByParent.get(parent)),
            attempts: [],
          })
          continue
        }

        if (action === 'settled-reserve') {
          if (settled.length > 0) {
            const entry = randomElement(random, settled)
            assert.throws(() => entry.operation.reserveNext(), /already settled/)
          }
          assertModelMatches()
          continue
        }

        const entry = randomElement(random, live)

        if (action === 'reserve' || action === 'reserve-exact') {
          const reservedBefore = new Set(book.reservedNames(entry.parent))
          const exact = action === 'reserve-exact'
          const allocated = entry.operation.reserveNext(exact ? { exact: true } : undefined)
          if (!exact) {
            assertIsValidAllocation(allocated, entry.requested, [
              ...occupiedByParent.get(entry.parent),
              ...reservedBefore,
            ])
          }
          const counts = model.get(entry.parent)
          counts.set(allocated, (counts.get(allocated) ?? 0) + 1)
          entry.attempts.push(allocated)
        } else if (action === 'conflict' || action === 'success') {
          const last = entry.attempts[entry.attempts.length - 1]
          if (last !== undefined) {
            entry.operation[action === 'conflict' ? 'markConflict' : 'markSuccess'](last)
            occupiedByParent.get(entry.parent).add(last)
          }
        } else {
          releaseEntry(entry)
          if (action === 're-release') entry.operation.release()
          live.splice(live.indexOf(entry), 1)
          settled.push(entry)
        }
        assertModelMatches()
      }

      for (const entry of live) releaseEntry(entry)
      assertModelMatches()
      for (const parent of parents) assert.deepEqual(book.reservedNames(parent), [])
    }
  })

  it('equivalent inputs: Control UI and Desktop-shaped conflicts resolve to the same decision', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x80)
    const statuses = [200, 201, 400, 401, 403, 404, 409, 410, 422, 429, 500, 503]
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const status = randomElement(random, statuses)
      const message = randomElement(random, BENIGN_MESSAGES)
      const controlUiError = Object.assign(new Error(`${status} ${message}`), {
        status,
        code: status === 409 ? 'conflict' : 'request_failed',
      })
      const desktopError = new Error(
        `Error invoking remote method 'gfs:createFileFromPath': Error: ${status} Conflict: [object Object]`
      )
      const expected = status === 409
      assert.equal(isGfsNameConflict(controlUiError), expected)
      assert.equal(isGfsNameConflict(desktopError), expected)
      assert.equal(isGfsNameConflict(controlUiError), isGfsNameConflict(desktopError))
      assert.equal(isGfsNameConflict(controlUiError), isGfsNameConflict(controlUiError))
      const retryLimit = randomInteger(random, 1, 8)
      for (const attempt of [0, randomInteger(random, 0, retryLimit - 1), retryLimit - 1]) {
        assert.equal(
          gfsUploadNameRetryDecision(controlUiError, { attempt, retryLimit }),
          gfsUploadNameRetryDecision(desktopError, { attempt, retryLimit })
        )
      }
    }
  })

  it('equivalent inputs: naming decisions are stable across input form and occupied order', () => {
    const random = createSeededRandom(PROPERTY_SEED ^ 0x90)
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const requested = randomResourceName(random)
      const occupied = [...randomOccupiedNames(random, requested)]
      const first = nextAvailableGfsResourceName(
        requested.normalize('NFD'),
        [...occupied].reverse()
      )
      const second = nextAvailableGfsResourceName(requested, occupied)
      assert.equal(first, second)
    }
  })
})
