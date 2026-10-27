'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const policy = require('./dragPolicy.cjs')
const {
  GFS_MOVE_MAX_NETWORK_ATTEMPTS,
  decideDragAuthority,
  decideDragPathStructure,
  decideDragStructure,
  normalizeCanonicalPath,
  parentPathOf,
  planMoveConvergence,
} = policy

const PROPERTY_RUNS = 300
const PROPERTY_SEED = 0x5eed_2026

function createSeededRandom(seed) {
  let state = seed >>> 0 || 0x6d2b79f5
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function randomInteger(random, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(random() * (maxInclusive - minInclusive + 1))
}

// ── random tree fixture for structural properties ────────────────────────────

/** Nodes 0..n-1; parent[i] < i (so node 0 is the root); 'x' marks unrelated drive roots. */
function randomTree(random, size) {
  const parentOf = [null]
  for (let index = 1; index < size; index += 1) {
    parentOf.push(randomInteger(random, 0, index - 1))
  }
  return parentOf
}

function ancestorsOf(parentOf, nodeId) {
  const chain = []
  let current = parentOf[nodeId]
  while (current !== null && current !== undefined) {
    chain.push(String(current))
    current = parentOf[current]
  }
  return chain
}

function isDescendant(parentOf, candidateId, ancestorId) {
  let current = parentOf[candidateId]
  while (current !== null && current !== undefined) {
    if (String(current) === String(ancestorId)) return true
    current = parentOf[current]
  }
  return false
}

describe('dragPolicy: decideDragStructure — unit behavior', () => {
  const source = (overrides = {}) => ({
    resourceId: 'S',
    drive: 'main',
    kind: 'directory',
    parentKnown: true,
    parentResourceId: 'P',
    ...overrides,
  })
  const target = (overrides = {}) => ({ resourceId: 'T', drive: 'main', ...overrides })

  it('denies self, cross-drive, root-source and same-parent in that priority', () => {
    assert.deepEqual(
      decideDragStructure({ source: source(), target: target({ resourceId: 'S' }) }),
      {
        kind: 'deny',
        reason: 'self',
      }
    )
    assert.deepEqual(
      decideDragStructure({ source: source({ drive: 'other' }), target: target() }),
      { kind: 'deny', reason: 'cross-drive' }
    )
    assert.deepEqual(
      decideDragStructure({ source: source({ parentResourceId: null }), target: target() }),
      { kind: 'deny', reason: 'root-source' }
    )
    assert.deepEqual(
      decideDragStructure({ source: source({ parentResourceId: 'T' }), target: target() }),
      { kind: 'deny', reason: 'same-parent' }
    )
  })

  it('files are structurally safe without any ancestor traversal', () => {
    assert.deepEqual(
      decideDragStructure({
        source: source({ kind: 'file' }),
        target: target(),
        targetAncestorIds: ['S', 'X'],
      }),
      { kind: 'observed-safe', evidence: 'file' }
    )
  })

  it('unknown parent is distinct from root and never fabricates a structural fact', () => {
    assert.deepEqual(
      decideDragStructure({
        source: source({ parentKnown: false, parentResourceId: null }),
        target: target(),
      }),
      { kind: 'server-check-required' }
    )
    // An unknown parent cannot certify same-parent even when ids coincide.
    assert.deepEqual(
      decideDragStructure({
        source: source({ parentKnown: false, parentResourceId: 'T' }),
        target: target(),
      }),
      { kind: 'server-check-required' }
    )
  })

  it('a loaded chain containing the source denies descendant', () => {
    assert.deepEqual(
      decideDragStructure({
        source: source(),
        target: target(),
        targetAncestorIds: ['T-child', 'S'],
      }),
      { kind: 'deny', reason: 'descendant' }
    )
  })

  it('a common anchor above the source proves the negative observation', () => {
    assert.deepEqual(
      decideDragStructure({
        source: source(),
        target: target(),
        targetAncestorIds: ['T-parent', 'P'],
        knownSourceAncestorIds: new Set(['P', 'ROOT']),
      }),
      { kind: 'observed-safe', evidence: 'common-anchor' }
    )
  })

  it('an unproved chain defers to the server check instead of denying', () => {
    assert.deepEqual(
      decideDragStructure({ source: source(), target: target(), targetAncestorIds: ['Q'] }),
      { kind: 'server-check-required' }
    )
    assert.deepEqual(decideDragStructure({ source: source(), target: target() }), {
      kind: 'server-check-required',
    })
  })

  it('a chain walked to the physical root without meeting the source is safe', () => {
    assert.deepEqual(
      decideDragStructure({
        source: source(),
        target: target(),
        targetAncestorIds: ['A', 'B', null],
      }),
      { kind: 'observed-safe', evidence: 'known-chain' }
    )
  })

  it('exposes the network-attempt cap', () => {
    assert.equal(typeof GFS_MOVE_MAX_NETWORK_ATTEMPTS, 'number')
    assert.ok(GFS_MOVE_MAX_NETWORK_ATTEMPTS >= 1)
  })
})

describe('dragPolicy: decideDragStructure — properties on random trees', () => {
  const random = createSeededRandom(PROPERTY_SEED)

  for (let run = 0; run < PROPERTY_RUNS; run += 1) {
    const size = randomInteger(random, 2, 24)
    const parentOf = randomTree(random, size)
    const sourceId = randomInteger(random, 0, size - 1)
    const targetId = randomInteger(random, 0, size - 1)
    const chain = ancestorsOf(parentOf, targetId)
    const sourceAncestors = new Set(ancestorsOf(parentOf, sourceId))
    const verdict = decideDragStructure({
      source: {
        resourceId: String(sourceId),
        drive: 'main',
        kind: sourceId === 0 ? 'directory' : 'directory',
        parentKnown: true,
        parentResourceId: parentOf[sourceId] === null ? null : String(parentOf[sourceId]),
      },
      target: { resourceId: String(targetId), drive: 'main' },
      targetAncestorIds: chain,
      knownSourceAncestorIds: sourceAncestors,
    })

    it(`run ${run}: tree=${size} source=${sourceId} target=${targetId} verdict=${verdict.kind}`, () => {
      if (sourceId === targetId) {
        assert.equal(verdict.kind, 'deny')
        assert.equal(verdict.reason, 'self')
        return
      }
      if (sourceId === 0) {
        // Root source.
        assert.equal(verdict.kind, 'deny')
        assert.equal(verdict.reason, 'root-source')
        return
      }
      if (parentOf[sourceId] === targetId) {
        assert.deepEqual(verdict, { kind: 'deny', reason: 'same-parent' })
        return
      }
      const targetInsideSource = isDescendant(parentOf, targetId, sourceId)
      if (verdict.kind === 'deny' && verdict.reason === 'descendant') {
        // A deny is only allowed when the target truly is inside the subtree.
        assert.equal(targetInsideSource, true)
      } else if (verdict.kind === 'observed-safe') {
        // Soundness: never certify a target that is truly inside the subtree.
        assert.equal(targetInsideSource, false)
      } else {
        assert.equal(verdict.kind, 'server-check-required')
      }
    })
  }
})

describe('dragPolicy: canonical path helpers and path guard', () => {
  it('normalizes only real server strings; everything else is unknown', () => {
    assert.equal(normalizeCanonicalPath('/A/B'), '/A/B')
    assert.equal(normalizeCanonicalPath('A/B'), '/A/B')
    assert.equal(normalizeCanonicalPath('/A/B/'), '/A/B')
    assert.equal(normalizeCanonicalPath('/'), '/')
    assert.equal(normalizeCanonicalPath(''), null)
    assert.equal(normalizeCanonicalPath(null), null)
    assert.equal(normalizeCanonicalPath(undefined), null)
  })

  it('parentPathOf: root has none, top folders have root, deeper folders trim', () => {
    assert.equal(parentPathOf('/'), null)
    assert.equal(parentPathOf('/A'), '/')
    assert.equal(parentPathOf('/A/B'), '/A')
  })

  it('guards the /A versus /AB segment boundary', () => {
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/A', targetPath: '/AB' }), {
      kind: 'observed-safe',
      evidence: 'fresh-path',
    })
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/A', targetPath: '/A/B' }), {
      kind: 'deny',
      reason: 'descendant',
    })
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/A', targetPath: '/A' }), {
      kind: 'deny',
      reason: 'self',
    })
  })

  it('root source and same-parent detection via canonical paths', () => {
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/', targetPath: '/A' }), {
      kind: 'deny',
      reason: 'root-source',
    })
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/A', targetPath: '/' }), {
      kind: 'deny',
      reason: 'same-parent',
    })
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/P/X', targetPath: '/P' }), {
      kind: 'deny',
      reason: 'same-parent',
    })
  })

  it('null or stale paths never certify structure', () => {
    assert.deepEqual(decideDragPathStructure({ sourcePath: null, targetPath: '/A' }), {
      kind: 'server-check-required',
    })
    assert.deepEqual(decideDragPathStructure({ sourcePath: '/A', targetPath: null }), {
      kind: 'server-check-required',
    })
  })
})

describe('dragPolicy: decideDragAuthority', () => {
  it('unknown bits stay checking; independent bits are evaluated separately', () => {
    assert.deepEqual(decideDragAuthority({}), { kind: 'checking' })
    assert.deepEqual(
      decideDragAuthority({ sourceParentHeld: ['read', 'write'], destinationHeld: ['write'] }),
      { kind: 'deny', reason: 'source-delete' }
    )
    assert.deepEqual(
      decideDragAuthority({ sourceParentHeld: ['read'], destinationHeld: ['write'] }),
      { kind: 'deny', reason: 'source-write' }
    )
    assert.deepEqual(
      decideDragAuthority({ sourceParentHeld: ['write', 'delete'], destinationHeld: ['read'] }),
      { kind: 'deny', reason: 'destination-write' }
    )
    assert.deepEqual(
      decideDragAuthority({ sourceParentHeld: ['write', 'delete'], destinationHeld: ['write'] }),
      { kind: 'observed-allowed', checkedAt: 0 }
    )
    assert.deepEqual(
      decideDragAuthority({
        sourceParentHeld: ['write', 'delete'],
        destinationHeld: ['write'],
        checkedAt: 42,
      }),
      { kind: 'observed-allowed', checkedAt: 42 }
    )
  })

  it('an unanswerable probe is unavailable, never a denial', () => {
    for (const reason of ['rate-limit', 'transport', 'session']) {
      assert.deepEqual(
        decideDragAuthority({
          sourceParentHeld: ['write'],
          destinationHeld: [],
          unavailable: reason,
        }),
        { kind: 'unavailable', reason }
      )
    }
  })

  it('destination is evaluated first, then source-write before source-delete', () => {
    assert.deepEqual(decideDragAuthority({ sourceParentHeld: [], destinationHeld: [] }), {
      kind: 'deny',
      reason: 'destination-write',
    })
    assert.deepEqual(decideDragAuthority({ sourceParentHeld: [], destinationHeld: ['write'] }), {
      kind: 'deny',
      reason: 'source-write',
    })
  })
})

describe('dragPolicy: planMoveConvergence', () => {
  it('refetches exactly the old and new parent listings, deduped', () => {
    assert.deepEqual(planMoveConvergence({ resourceId: 'M', oldParentId: 'A', newParentId: 'B' }), {
      refetchChildIds: ['A', 'B'],
      staleResourceIds: ['M'],
    })
    assert.deepEqual(planMoveConvergence({ resourceId: 'M', oldParentId: 'A', newParentId: 'A' }), {
      refetchChildIds: ['A'],
      staleResourceIds: ['M'],
    })
    assert.deepEqual(
      planMoveConvergence({ resourceId: 'M', oldParentId: null, newParentId: 'B' }),
      { refetchChildIds: ['B'], staleResourceIds: ['M'] }
    )
  })

  it('marks the moved resource plus its KNOWN cached descendants stale', () => {
    const links = new Map([
      ['c1', 'M'],
      ['c2', 'c1'],
      ['d1', 'B'],
      ['c3', null],
    ])
    const plan = planMoveConvergence(
      { resourceId: 'M', oldParentId: 'A', newParentId: 'B' },
      { childParentByResourceId: links }
    )
    assert.deepEqual(plan.refetchChildIds, ['A', 'B'])
    assert.deepEqual([...plan.staleResourceIds].sort(), ['M', 'c1', 'c2'])
  })

  it('never claims unknown descendants: unlinked rows stay untouched', () => {
    const plan = planMoveConvergence(
      { resourceId: 'M', oldParentId: 'A', newParentId: 'B' },
      {
        childParentByResourceId: new Map([
          ['x', 'y'],
          ['y', null],
        ]),
      }
    )
    assert.deepEqual(plan.staleResourceIds, ['M'])
  })

  it('requires a receipt resourceId', () => {
    assert.throws(() => planMoveConvergence({}), TypeError)
  })
})
