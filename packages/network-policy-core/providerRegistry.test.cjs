'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const registry = require('./providerRegistry.cjs')
const core = require('./index.cjs')

// REG-1: exact on-pool GitHub hosts resolve to the correct category unions.
test('REG-1 exact on-pool github hosts', () => {
  assert.deepEqual(registry.lookupFqdnProvider('api.github.com'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['api'] },
  })
  assert.deepEqual(registry.lookupFqdnProvider('codeload.github.com'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['web', 'api', 'git'] },
  })
  assert.deepEqual(registry.lookupFqdnProvider('ghcr.io'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['api', 'web'] },
  })
  assert.deepEqual(registry.lookupFqdnProvider('github.com'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['web', 'api'] },
  })
  assert.deepEqual(registry.lookupFqdnProvider('gist.github.com'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['web', 'api'] },
  })
})

// REG-2: *.githubusercontent.com is GitHub-owned anycast — wildcard union.
test('REG-2 githubusercontent wildcard', () => {
  const expected = { kind: 'mapped', row: { provider: 'github', categories: ['web', 'api', 'git'] } }
  assert.deepEqual(registry.lookupFqdnProvider('raw.githubusercontent.com'), expected)
  assert.deepEqual(registry.lookupFqdnProvider('objects.githubusercontent.com'), expected)
})

// REG-3: hostname suffix NEVER classifies — off-pool exact beats wildcard, and
// an explicit unmapped exact row beats the wildcard it sits under.
test('REG-3 off-pool exact beats wildcard; unmapped beats suffix', () => {
  assert.deepEqual(registry.lookupFqdnProvider('github-cloud.s3.amazonaws.com'), {
    kind: 'mapped',
    row: { provider: 'aws', categories: ['S3'] },
  })
  assert.deepEqual(registry.lookupFqdnProvider('anything.s3.amazonaws.com'), {
    kind: 'mapped',
    row: { provider: 'aws', categories: ['S3'] },
  })
  const azure = registry.lookupFqdnProvider('pipelines.actions.githubusercontent.com')
  assert.equal(azure.kind, 'unmapped')
  assert.equal(typeof azure.note, 'string')
  assert.ok(azure.note.length > 0)
})

// REG-4: unknown host → undefined; case-insensitive; bare-suffix host is not a hit.
test('REG-4 unknown / case / bare-suffix', () => {
  assert.equal(registry.lookupFqdnProvider('example.com'), undefined)
  assert.deepEqual(registry.lookupFqdnProvider('GITHUB.COM'), {
    kind: 'mapped',
    row: { provider: 'github', categories: ['web', 'api'] },
  })
  assert.equal(registry.lookupFqdnProvider('githubusercontent.com'), undefined)
})

// REG-5: per-provider bounds; unknown provider → defaults.
test('REG-5 provider bounds', () => {
  assert.equal(registry.providerBounds('google').minPrefixLength, 12)
  assert.equal(registry.providerBounds('github').maxRanges, 256)
  assert.deepEqual(registry.providerBounds('nonexistent'), {
    minPrefixLength: 16,
    maxRanges: 256,
    maxSpanAddresses: 2 ** 22,
  })
})

// REG-DERIVED: the gate's provider-name set is DERIVED from the registry data
// (single source of truth), never hardcoded. Every provider named in any row or
// bounds entry must appear in providerNames, and the list must be non-empty.
test('REG-DERIVED providerNames is derived from the data and complete', () => {
  const names = registry.providerNames
  assert.ok(Array.isArray(names) && names.length > 0, 'providerNames must be a non-empty array')
  // Every mapped/off-pool row provider is represented.
  for (const host of ['api.github.com', 'github-cloud.s3.amazonaws.com']) {
    const l = registry.lookupFqdnProvider(host)
    if (l && l.kind === 'mapped') assert.ok(names.includes(l.row.provider), `${l.row.provider} missing from providerNames`)
  }
  // The five providers with bounds rows are all present (M1..M4 coverage).
  for (const p of ['github', 'google', 'aws', 'cloudfront', 'microsoft']) {
    assert.ok(names.includes(p), `${p} missing from providerNames`)
  }
  // Sorted + deduped (deterministic for the gate).
  assert.deepEqual(names, [...new Set(names)].sort())
})

// REG-6: catalog-driven provider add. A provider the registry has NO row for is
// exercised end-to-end through resolveProviderRanges using ONLY declared
// categories + a CM key — proving "adding a provider = data (CM key) +
// declaration", with zero change to core, registry, schema, or validators.
test('REG-6 catalog-driven synthetic provider add (generality)', () => {
  const r = core.resolveProviderRanges({
    fqdn: 'api.example-provider.test',
    declaredName: 'exampleco',
    declaredCategories: ['edge'],
    registryLookup: registry.lookupFqdnProvider('api.example-provider.test'), // undefined — no row
    cmCategories: { 'exampleco.edge': ['198.41.128.0/17'] },
    bounds: registry.providerBounds('exampleco'), // unknown → default bounds
  })
  assert.deepEqual(r, { kind: 'ok', ranges: ['198.41.128.0/17'], categories: ['edge'] })
})
