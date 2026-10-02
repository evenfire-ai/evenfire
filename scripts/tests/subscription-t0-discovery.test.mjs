import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  auditSubscriptionDiscovery,
  isSubscriptionCandidate,
  namedRoots,
  verifyRuntimeConsumer,
} from './lib/subscription-t0-discovery.mjs'

function suiteRoots(provider) {
  return provider === 'grok'
    ? ['grok-llm-proxy/test', 'packages/grok-provider-attempt-contract']
    : ['codex-llm-proxy/test', 'packages/llm-provider-attempt-contract']
}

function createFile(root, relative, content = '') {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return relative
}

function makeFixture(t, provider = 'codex') {
  const root = mkdtempSync(path.join(tmpdir(), `subscription-discovery-${provider}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registered = []
  for (const directory of [...suiteRoots(provider), ...namedRoots]) {
    mkdirSync(path.join(root, directory), { recursive: true })
  }
  for (const [index, directory] of suiteRoots(provider).entries()) {
    const file = `${directory}/${provider}-suite-${index}.test.ts`
    createFile(root, file)
    registered.push(file)
  }
  namedRoots.forEach((directory, index) => {
    createFile(root, `${directory}/baseline-${index}.test.ts`)
  })
  return { root, registered }
}

test('admits the three formerly omitted roots through their physical file entries', t => {
  const fixture = makeFixture(t)
  const desktop = createFile(
    fixture.root,
    'desktop-app/ui/src/constants/__tests__/attachments.test.ts',
  )
  const host = createFile(
    fixture.root,
    'mcp-host/src/llm/__tests__/attachmentBudgetRefusal.test.ts',
  )
  const e2e = createFile(
    fixture.root,
    'tests/e2e/integration/codex-subscription-contract-freeze.test.ts',
  )
  const scripts = createFile(
    fixture.root,
    'scripts/e2e/prepare-codex-approved-tools.test.mjs',
  )
  const registered = [...fixture.registered, desktop, host, e2e, scripts]
  const result = auditSubscriptionDiscovery('codex', fixture.root, registered)

  assert.deepEqual(result.violations, [])
  const lanes = new Map(result.candidates.map(entry => [entry.file, entry.lane]))
  for (const file of [desktop, host, e2e, scripts]) assert.equal(lanes.get(file), 'T0')
  for (const root of ['desktop-app', 'tests/e2e', 'scripts/e2e']) {
    assert.ok(result.roots.includes(root))
  }
})

test('generic attachment candidates belong to both provider lanes; provider names stay isolated', () => {
  const attachment = 'any/deep/attachments.test.ts'
  const codex = 'mcp-host/src/llm/__tests__/codexSubscription.test.ts'
  const grok = 'mcp-host/src/llm/__tests__/grokSubscription.test.ts'
  assert.equal(isSubscriptionCandidate(attachment, 'codex'), true)
  assert.equal(isSubscriptionCandidate(attachment, 'grok'), true)
  assert.equal(isSubscriptionCandidate(codex, 'codex'), true)
  assert.equal(isSubscriptionCandidate(codex, 'grok'), false)
  assert.equal(isSubscriptionCandidate(grok, 'grok'), true)
  assert.equal(isSubscriptionCandidate(grok, 'codex'), false)
})

test('missing and empty discovery roots fail with their exact causal violation', t => {
  const missing = makeFixture(t)
  rmSync(path.join(missing.root, 'tests/e2e'), { recursive: true, force: true })
  const missingResult = auditSubscriptionDiscovery('codex', missing.root, missing.registered)
  assert.ok(missingResult.violations.includes('missing discovery root tests/e2e'))

  const empty = makeFixture(t, 'grok')
  rmSync(path.join(empty.root, 'mcp-host/baseline-1.test.ts'))
  const emptyResult = auditSubscriptionDiscovery('grok', empty.root, empty.registered)
  assert.ok(emptyResult.violations.includes('empty discovery root mcp-host'))
})

test('duplicate and missing registered physical suites fail closed', t => {
  const fixture = makeFixture(t)
  const duplicateResult = auditSubscriptionDiscovery(
    'codex',
    fixture.root,
    [...fixture.registered, fixture.registered[0]],
  )
  assert.ok(duplicateResult.violations.includes('duplicate registered physical suite'))

  const missingRelative = 'control-api/test/missing-registered-suite.test.ts'
  createFile(path.dirname(path.join(fixture.root, missingRelative)), path.basename(missingRelative))
  rmSync(path.join(fixture.root, missingRelative))
  const missingResult = auditSubscriptionDiscovery(
    'codex',
    fixture.root,
    [...fixture.registered, missingRelative],
  )
  assert.ok(
    missingResult.violations.includes(`missing or invalid registered suite ${missingRelative}`),
  )
})

test('an unlisted candidate is UNLISTED even when another candidate is registered', t => {
  const fixture = makeFixture(t)
  const unlisted = createFile(
    fixture.root,
    'mcp-host/src/llm/__tests__/newCodexSurface.test.ts',
  )
  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.ok(result.violations.includes(`unlisted codex subscription suite ${unlisted}`))
  const entry = result.candidates.find(candidate => candidate.file === unlisted)
  assert.equal(entry?.lane, 'UNLISTED')
})

test('registered real-PG suites are never confused with executed T0 suites', t => {
  const fixture = makeFixture(t)
  const suite = 'control-api/test/services.codexSubscriptionCatalog.realPostgres.integration.test.ts'
  createFile(fixture.root, suite)
  createFile(
    fixture.root,
    'control-api/vitest.config.ts',
    "export default { include: ['test/**/*.test.ts'] }\n",
  )
  createFile(
    fixture.root,
    '.github/workflows/ci-public.yml',
    `  control-api-migration:
    steps:
      - run: |
          CONTROL_API_REAL_PG_REQUIRED: '1'
          npm test -- --run realPostgres
`,
  )

  const registeredResult = auditSubscriptionDiscovery(
    'codex',
    fixture.root,
    [...fixture.registered, suite],
  )
  const registeredEntry = registeredResult.candidates.find(entry => entry.file === suite)
  assert.equal(registeredEntry?.lane, 'real-pg:control-api')
  assert.ok(
    registeredResult.violations.includes(`real-PG suite cannot be registered as a T0 unit ${suite}`),
  )

  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.deepEqual(result.violations, [])
  const entry = result.candidates.find(candidate => candidate.file === suite)
  assert.equal(entry?.lane, 'real-pg:control-api')
  assert.match(String(entry?.consumer), /control-api-migration/)
})

test('a realPostgres suffix alone is not a silent other-lane registry', t => {
  const fixture = makeFixture(t)
  const unknown = createFile(
    fixture.root,
    'control-api/test/unknownSubscription.realPostgres.integration.test.ts',
  )
  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.ok(result.violations.includes(`unlisted codex subscription suite ${unknown}`))
})

test('general CI lanes verify both matrix ownership and config collection', t => {
  const fixture = makeFixture(t)
  const suite = 'control-api/test/subscriptionGrantIdentity.test.ts'
  const config = 'control-api/vitest.config.ts'
  const workflow = '.github/workflows/ci-public.yml'
  createFile(fixture.root, suite)
  createFile(fixture.root, workflow, `jobs:
  test:
    strategy:
      matrix:
        service:
          - control-api
    steps:
      - run: npm test
`)
  createFile(fixture.root, config, "export default { include: ['test/**/*.test.ts'] }\n")

  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.deepEqual(result.violations, [])
  const entry = result.candidates.find(candidate => candidate.file === suite)
  assert.equal(entry?.lane, 'general-ci:control-api')
  assert.match(String(entry?.consumer), /#test \(control-api\)/)

  writeFileSync(path.join(fixture.root, config), "export default { include: ['test/other.test.ts'] }\n")
  const negative = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.ok(negative.violations.includes(`unverified general-ci:control-api consumer for ${suite}`))
})

test('Playwright runtime lanes require the registered config to collect the exact spec', t => {
  const fixture = makeFixture(t)
  const spec = 'tests/e2e/playwright/control-ui/codex-subscription-admission.spec.ts'
  const config = 'tests/e2e/playwright/playwright.subscription-admission.config.ts'
  createFile(fixture.root, spec)
  createFile(
    fixture.root,
    config,
    `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  testMatch: 'control-ui/codex-subscription-admission.spec.ts',
})
`,
  )

  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.deepEqual(result.violations, [])
  const entry = result.candidates.find(candidate => candidate.file === spec)
  assert.equal(entry?.lane, 'runtime-opt-in')
  assert.match(String(entry?.consumer), /collection-verified registry entry/)

  writeFileSync(
    path.join(fixture.root, config),
    `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  testMatch: 'control-ui/other.spec.ts',
})
`,
  )
  assert.equal(verifyRuntimeConsumer(fixture.root, spec, config), undefined)
  const negative = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.ok(negative.violations.includes(`runtime consumer does not collect ${spec}`))
})

test('shell runtime entries are explicit self entrypoints and reject non-entrypoint files', t => {
  const fixture = makeFixture(t)
  const script = 'scripts/e2e/e2e-codex-subscription-runtime.sh'
  createFile(fixture.root, script, '#!/usr/bin/env bash\nset -euo pipefail\n')
  chmodSync(path.join(fixture.root, script), 0o755)

  const result = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.deepEqual(result.violations, [])
  const entry = result.candidates.find(candidate => candidate.file === script)
  assert.equal(entry?.lane, 'runtime-opt-in')
  assert.match(String(entry?.consumer), /explicit self entrypoint/)

  chmodSync(path.join(fixture.root, script), 0o644)
  const negative = auditSubscriptionDiscovery('codex', fixture.root, fixture.registered)
  assert.ok(negative.violations.includes(`runtime consumer does not collect ${script}`))
})

test('a Playwright default project can collect a spec outside another project selector', t => {
  const fixture = makeFixture(t)
  const spec = 'desktop-app/test/e2e-playwright/plugin-workload-sdk-codex-fallback.spec.ts'
  const config = 'desktop-app/test/e2e-playwright/playwright.config.ts'
  createFile(fixture.root, spec)
  createFile(
    fixture.root,
    config,
    `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  projects: [
    {
      name: 'default',
      testIgnore: ['**/other-lane.spec.ts'],
    },
    {
      name: 'special',
      testMatch: /other-lane\\.spec\\.ts/,
    },
  ],
})
`,
  )

  assert.ok(verifyRuntimeConsumer(fixture.root, spec, config))
})

test('runtime suites cannot enter the T0 registry', t => {
  const fixture = makeFixture(t)
  const spec = 'tests/e2e/playwright/control-ui/codex-subscription-admission.spec.ts'
  const config = 'tests/e2e/playwright/playwright.subscription-admission.config.ts'
  createFile(fixture.root, spec)
  createFile(
    fixture.root,
    config,
    `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  testMatch: 'control-ui/codex-subscription-admission.spec.ts',
})
`,
  )
  const result = auditSubscriptionDiscovery(
    'codex',
    fixture.root,
    [...fixture.registered, spec],
  )
  assert.ok(
    result.violations.includes(`runtime suite cannot be registered as a T0 unit ${spec}`),
  )
})
