import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFixtureIdentityJournal } from '../../tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.mjs'
import {
  beginConnectionCapture,
  connectionCaptureName,
  validateConnectionCapture,
} from './approved-tools-connection-journal.mjs'
import {
  ingestFixtureConnections,
  makeScenarios,
  makeWorkflowScenario,
} from './prepare-codex-approved-tools.mjs'

const run = 'approved-tools-a1b2c3d4e5f6'
const profile = 'clerum-approved-tools-a1b2c3d4'
const env = {
  NODE_ENV: 'test',
  EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
  APPROVED_TOOLS_RUN_ID: run,
  MINIKUBE_PROFILE: profile,
  CONTROL_API_REAL_PG_CONTEXT: profile,
}
const binding = {
  run,
  profile,
  context: profile,
  scenario: '83',
  fixtureUserId: '11111111-1111-1111-1111-111111111111',
}
const body = {
  id: '22222222-2222-2222-2222-222222222222',
  connectionKey: 'codex-1234567890abcdef',
  displayName: `Codex fixture 83 ${run}`,
  createdBy: null,
}
function directory() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connection-journal-')))
}
test('intent is durable before UI creation; only public response fields survive in mode 0600', () => {
  const root = directory()
  try {
    const capture = beginConnectionCapture(root, binding)
    const filename = path.join(root, connectionCaptureName('83'))
    assert.equal(JSON.parse(fs.readFileSync(filename)).status, 'creation-pending')
    capture.record({ ...body, accessToken: 'must-not-persist' })
    capture.close()
    const raw = fs.readFileSync(filename, 'utf8')
    assert.equal(raw.includes('must-not-persist'), false)
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
    assert.equal(validateConnectionCapture(JSON.parse(raw), binding).id, body.id)
    assert.throws(() => beginConnectionCapture(root, binding), /EEXIST/)
    assert.throws(() =>
      validateConnectionCapture(JSON.parse(raw), { ...binding, run: 'approved-tools-000000000000' })
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('invalid response, symlink and replaced file never supply cleanup authority', () => {
  const root = directory()
  try {
    const capture = beginConnectionCapture(root, binding)
    const filename = path.join(root, connectionCaptureName('83'))
    assert.throws(() => capture.record({ ...body, createdBy: 'foreign' }))
    assert.equal(JSON.parse(fs.readFileSync(filename)).status, 'creation-pending')
    fs.unlinkSync(filename)
    fs.writeFileSync(filename, 'replacement', { mode: 0o600 })
    assert.throws(() => capture.record(body), /Unsafe/)
    capture.close()
    assert.equal(fs.readFileSync(filename, 'utf8'), 'replacement')
    fs.unlinkSync(filename)
    fs.symlinkSync(path.join(root, 'missing'), filename)
    assert.throws(() => beginConnectionCapture(root, binding))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('restore ingests exact response once and blocks pending, foreign and conflicting evidence', () => {
  const scenarios = makeScenarios(run, [43101, 43102, 43103], 43105)
  const workflowScenario = makeWorkflowScenario(run, 43104, 43105)
  const input = {
    mode: 'deterministic',
    run,
    profile,
    context: profile,
    scenarios: [...scenarios, workflowScenario],
  }
  const journal = createFixtureIdentityJournal(input, { env })
  journal.status = 'created'
  const state = { run, profile, scenarios, workflowScenario, identityJournal: journal }
  const bound = { ...binding, fixtureUserId: journal.users[0].id }
  const evidence = { scenario: '83', fixtureUserId: bound.fixtureUserId, ...body }
  const value = { version: 1, binding: bound, status: 'created', evidence }
  let saves = 0
  const read = name => (name === connectionCaptureName('83') ? JSON.stringify(value) : null)
  ingestFixtureConnections(state, read, () => saves++)
  ingestFixtureConnections(state, read, () => saves++)
  assert.equal(saves, 1)
  assert.deepEqual(journal.connections, [evidence])
  value.evidence.id = '33333333-3333-3333-3333-333333333333'
  assert.throws(() => ingestFixtureConnections(state, read, () => saves++), /Conflicting/)
  value.status = 'creation-pending'
  assert.throws(() => ingestFixtureConnections(state, read, () => saves++), /Incomplete/)
  assert.equal(saves, 1)
})
test('real page createGrant callback persists the response before later UI assertions and retains string return', async () => {
  const filename = path.resolve('tests/e2e/playwright/pages/codex-subscription.ts')
  // Execute the real method with unit adapters; no browser or Playwright dependency
  // is needed in the mcp-host CI lane that owns these lifecycle contracts.
  const source = fs.readFileSync(filename, 'utf8')
  const method = source.slice(
    source.indexOf('  async createGrant('),
    source.indexOf('  async openGrant(')
  )
  assert.ok(method.includes('onCreated'))
  const stripped = stripTypeScriptTypes(`class SecretsLlmSubscriptionsPage { ${method} }`)
  const SecretsLlmSubscriptionsPage = new Function(
    'expect',
    `${stripped}; return SecretsLlmSubscriptionsPage`
  )(value => ({
    toBe: expected => assert.equal(value, expected),
    toBeTruthy: () => assert.ok(value),
  }))
  const root = directory()
  try {
    const capture = beginConnectionCapture(root, binding)
    const page = {
      getByRole: () => ({ click: async () => {} }),
      getByLabel: () => ({ fill: async () => {} }),
      waitForResponse: () => Promise.resolve({ status: () => 201, json: async () => body }),
    }
    const subscriptions = new SecretsLlmSubscriptionsPage()
    subscriptions.page = page
    subscriptions.expectConnectModal = async () => {
      const stored = JSON.parse(fs.readFileSync(path.join(root, connectionCaptureName('83'))))
      assert.equal(stored.evidence.id, body.id)
      throw Error('later UI assertion failed')
    }
    await assert.rejects(
      subscriptions.createGrant(body.displayName, metadata => capture.record(metadata)),
      /later UI assertion failed/
    )
    capture.close()
    subscriptions.expectConnectModal = async () => {}
    assert.equal(await subscriptions.createGrant(body.displayName), body.connectionKey)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
