import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseIdentityFailure } from '../../../../../scripts/e2e/prepare-codex-approved-tools.mjs'
import { createFixtureIdentityJournal } from './identity-lifecycle.mjs'

// The seed runs inside the isolated Control API image, so its imports name
// absolute `/app/...` paths that only exist there. This test executes the same
// program through the same entry point (`node --eval`, JSON on stdin) and
// resolves those names to repository modules and local stubs.
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../../..')
const run = 'approved-tools-0123456789ab'
const profile = 'owned-e2e'
const env = {
  NODE_ENV: 'test',
  EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
  KUBERNETES_SERVICE_HOST: '127.0.0.1',
  APPROVED_TOOLS_RUN_ID: run,
  MINIKUBE_PROFILE: profile,
  CONTROL_API_REAL_PG_CONTEXT: profile,
}

function cleanupInput() {
  return {
    action: 'cleanup',
    mode: 'deterministic',
    suite: 'approved-tools',
    run,
    profile,
    context: profile,
    adminUsername: 'admin',
    scenarios: ['83', '150', '250', 'workflow'].map(label => ({
      runId: `${run}-${label}`,
      agentName: `${run}-agent-${label}`,
      contextName: `${run}-context-${label}`,
    })),
  }
}

// A deterministic stand-in for the Control API distribution. The transaction
// body only needs the journal rows it locks and checks, one active Control
// Admin, and a governed retirement that fails with the fence's SQLSTATE.
const dbStub = `
import fs from 'node:fs'
export const pool = { end: async () => {} }
const state = JSON.parse(fs.readFileSync(process.env.E2E_SEED_STUB_STATE, 'utf8'))
const rows = {
  users: state.users.map(user => ({ ...user, lifecycle_state: 'active' })),
  teams: [state.team],
  profiles: state.users.map(user => ({ user_id: user.id, display_name: user.name })),
  team_members: state.users.map(user => ({ team_id: state.team.id, user_id: user.id, role: 'member', status: 'active' })),
  user_agents: state.grants.agents.map(resource => ({ user_id: state.users[0].id, resource })),
  user_contexts: state.grants.contexts.map(resource => ({ user_id: state.users[0].id, resource })),
  user_workflow_triggers: [{
    user_id: state.users[0].id,
    recipe_namespace: state.grants.workflow.namespace,
    recipe_name: state.grants.workflow.name,
  }],
  control_admin_users: [{ id: state.controlAdminId }],
}
export async function withTransaction(work) {
  const db = {
    query: async (sql, values) => {
      process.stderr.write('STUB_QUERY ' + sql.split('\\n')[0].trim() + '\\n')
      const table = /FROM ([a-z_]+)/.exec(sql)?.[1]
      if (sql.startsWith('DELETE')) return { rowCount: 1, rows: [{ id: 'deleted' }] }
      const found = rows[table] ?? []
      return { rows: found, rowCount: found.length }
    },
  }
  return work(db)
}
`

const usersStub = `
export async function retireDesktopUserInTransaction(db, request) {
  if (process.env.E2E_SEED_RETIREMENT_SQLSTATE)
    throw { code: process.env.E2E_SEED_RETIREMENT_SQLSTATE }
  return { id: request.userId, outcome: 'deleted', operationId: 'stub', lifecycleVersion: null, replayed: false }
}
`

const runtimeConfigStub = `export const config = { hostsNamespace: 'control-plane' }\n`
const allowlistWriterStub =
  'export class LlmAllowedModelsConfigMapWriter {\n' +
  '  constructor(client, namespace) { this.client = client; this.namespace = namespace }\n' +
  '  async materialize() {}\n' +
  '}\n'
const kubernetesStub =
  'export class KubeConfig { loadFromCluster() {} makeApiClient() { return {} } }\n' +
  'export class CoreV1Api {}\n'

const hookModule = `
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const map = JSON.parse(process.env.E2E_SEED_RESOLVE_MAP)
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [prefix, target] of Object.entries(map))
      if (specifier.startsWith(prefix))
        return { url: pathToFileURL(target + specifier.slice(prefix.length)).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
`

function write(root, name, value) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
  return file
}

// Runs the seed exactly as the host does: the recorded source on stdin-driven
// `node --eval` inside a process whose `/app` imports resolve locally.
function runSeed({ retireSqlstate } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-tools-seed-'))
  try {
    const dist = path.join(root, 'dist')
    write(dist, 'db.js', dbStub)
    write(dist, 'config.js', runtimeConfigStub)
    write(dist, 'services/directory/users.js', usersStub)
    write(dist, 'services/llmAllowedModelsConfigMap.js', allowlistWriterStub)
    write(
      dist,
      'services/tracing/controlApiPermissionEvents.js',
      'export async function appendControlApiPermissionEventsInTransaction() {}\n'
    )
    write(
      dist,
      'services/codexSubscriptionConnection.js',
      'export async function revokeCodexSubscriptionConnection() {}\n'
    )
    write(
      dist,
      'services/codexSubscriptionCatalog.js',
      'export async function rebuildLiveCodexUnionAllowlist() {}\n'
    )
    const kubernetes = write(root, 'kubernetes.mjs', kubernetesStub)
    const hook = write(root, 'hook.mjs', hookModule)
    const input = cleanupInput()
    const journal = createFixtureIdentityJournal(input, { env })
    const stateFile = write(
      root,
      'state.json',
      JSON.stringify({ ...journal, controlAdminId: '99999999-9999-4999-8999-999999999999' })
    )
    const source = fs.readFileSync(path.join(here, 'seed.mjs'), 'utf8')
    const result = spawnSync(
      process.execPath,
      ['--import', hook, '--input-type=module', '--eval', source],
      {
        input: JSON.stringify({ ...input, initialJournal: journal }),
        encoding: 'utf8',
        env: {
          ...env,
          E2E_SEED_STUB_STATE: stateFile,
          ...(retireSqlstate ? { E2E_SEED_RETIREMENT_SQLSTATE: retireSqlstate } : {}),
          E2E_SEED_RESOLVE_MAP: JSON.stringify({
            '/app/control-api/node_modules/@kubernetes/client-node/dist/index.js': kubernetes,
            '/app/approved-tools-setup/': here + path.sep,
            '/app/control-api/node_modules/':
              path.join(repo, 'control-api/node_modules') + path.sep,
            '/app/control-api/dist/': dist + path.sep,
          }),
        },
      }
    )
    return { result, journal }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a failed cleanup process reports the coded triple the host parser accepts', () => {
  const { result, journal } = runSeed({ retireSqlstate: '55000' })
  assert.equal(result.status, 1)
  // Liveness: the failure came from the governed retirement inside the cleanup
  // transaction, not from the environment or an earlier refusal.
  assert.match(result.stderr, /FROM control_admin_users/)
  assert.match(result.stderr, /Fixture identity operation failed/)
  const failure = parseIdentityFailure(result.stdout)
  assert.deepEqual(failure, { code: 'db_error', phase: 'delete-users', sqlstate: '55000' })
  assert.equal(JSON.stringify(failure).includes('raw runtime text'), false)
  const reported = result.stdout
    .split('\n')
    .filter(line => line.includes('e2eIdentity'))
    .map(line => JSON.parse(line))
  assert.ok(
    reported.some(value => value.e2eIdentity?.status === 'recovery-required'),
    'the journal records the terminal status before the coded line'
  )
  assert.equal(journal.status, 'creation-pending')
})

test('a successful cleanup process reports the cleaned journal and no coded failure', () => {
  const { result, journal } = runSeed()
  assert.equal(result.status, 0)
  assert.match(result.stderr, /FROM control_admin_users/)
  assert.equal(parseIdentityFailure(result.stdout).code, 'unparseable')
  const cleaned = result.stdout
    .split('\n')
    .filter(line => line.includes('e2eIdentity'))
    .map(line => JSON.parse(line))
    .at(-1).e2eIdentity
  assert.equal(cleaned.status, 'cleaned')
  assert.equal(cleaned.cleanupOutcome, 'deleted-with-audit-retained')
  assert.equal(cleaned.run, journal.run)
})
