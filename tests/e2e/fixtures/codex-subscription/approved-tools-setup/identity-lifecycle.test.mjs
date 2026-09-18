import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  cleanupFixtureIdentities,
  createFixtureIdentityJournal,
  createFixtureIdentities as createRecordedFixtureIdentities,
  describeFixtureError,
  recordFixtureConnection,
} from './identity-lifecycle.mjs'

async function createFixtureIdentities(input, deps) {
  return createRecordedFixtureIdentities(input, {
    ...deps,
    initialJournal: createFixtureIdentityJournal(input, { env: deps.env }),
  })
}

const run = 'approved-tools-aabbccddeeff'
const input = {
  mode: 'deterministic',
  run,
  profile: 'owned-e2e',
  context: 'owned-e2e',
  userEmail: `${run}@example.test`,
  unauthorizedEmail: `${run}-unauthorized@example.test`,
  userPassword: 'fixture-only-member-password',
  unauthorizedPassword: 'fixture-only-negative-password',
  scenarios: ['83', '150', '250', 'workflow'].map(label => ({
    runId: `${run}-${label}`,
    agentName: `${run}-agent-${label}`,
    contextName: `${run}-context-${label}`,
  })),
}
const env = {
  NODE_ENV: 'test',
  EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
  APPROVED_TOOLS_RUN_ID: run,
  MINIKUBE_PROFILE: input.profile,
  CONTROL_API_REAL_PG_CONTEXT: input.context,
}

test('seed keeps bounded fixture diagnostics in catch scope', () => {
  const source = readFileSync(new URL('./seed.mjs', import.meta.url), 'utf8')
  const binding = source.indexOf(
    'const { createFixtureIdentities, cleanupFixtureIdentities, describeFixtureError }'
  )
  const tryBlock = source.indexOf('\ntry {')
  const diagnosticUse = source.indexOf('failure: describeFixtureError(error)')
  assert.ok(binding >= 0)
  assert.ok(binding < tryBlock)
  assert.ok(diagnosticUse > tryBlock)
})

function harness() {
  const state = {
    calls: [],
    journal: [],
    committed: [],
    events: [],
    rollbacks: 0,
    commits: 0,
    publications: 0,
    transactionActive: false,
  }
  const adapters = {
    env,
    // Synthetic hash is intentional: tests verify wiring and never authenticate.
    hashPassword: async (password, rounds) => {
      assert.equal(rounds, 12)
      assert.ok([input.userPassword, input.unauthorizedPassword].includes(password))
      return '$2b$12$' + 'a'.repeat(53)
    },
    saveJournal: async value => {
      assert.ok(!JSON.stringify(value).includes('password'))
      state.journal.push(structuredClone(value))
    },
    publishRuntimeAllowlist: async () => {
      assert.equal(state.transactionActive, false, 'publish only after transaction completion')
      state.publications++
      if (state.publicationFailure) throw new Error('synthetic publication failure')
    },
    appendPermissionEvents: async (db, value) => {
      assert.equal(db, state.db)
      if (state.auditFailure) throw new Error('audit failure')
      state.events.push(value)
    },
    withTransaction: async callback => {
      const pending = []
      const db = {
        query: async (sql, values = []) => {
          state.calls.push({ sql, values })
          if (state.failQuery?.(sql)) throw new Error('synthetic query failure')
          pending.push({ sql, values })
          if (state.respond) return state.respond(sql, values)
          return { rows: [], rowCount: 1 }
        },
      }
      state.db = db
      state.transactionActive = true
      try {
        const result = await callback(db)
        state.committed.push(...pending)
        state.commits++
        if (state.commitLost) throw new Error('commit response lost')
        return result
      } catch (error) {
        state.rollbacks++
        throw error
      } finally {
        state.transactionActive = false
      }
    },
  }
  return { state, adapters }
}

test('remote creation preserves host-recorded IDs and refuses a reused intent', async () => {
  const { state, adapters } = harness()
  const initialJournal = createFixtureIdentityJournal(input, { env })
  const original = structuredClone(initialJournal)
  const created = await createRecordedFixtureIdentities(input, { ...adapters, initialJournal })
  assert.deepEqual(created.users, original.users)
  assert.deepEqual(created.team, original.team)
  assert.deepEqual(initialJournal, original)
  const calls = state.calls.length
  await assert.rejects(
    createRecordedFixtureIdentities(input, { ...adapters, initialJournal: created }),
    /fresh identity intent/
  )
  const prebound = structuredClone(initialJournal)
  prebound.connections.push(connectionEvidence(prebound))
  await assert.rejects(
    createRecordedFixtureIdentities(input, { ...adapters, initialJournal: prebound }),
    /fresh identity intent/
  )
  assert.equal(state.calls.length, calls)
})

function cleanupRows(journal, overrides = {}) {
  return sql => {
    const table = /FROM ([a-z_]+)/.exec(sql)?.[1]
    if (sql.startsWith('DELETE')) return { rowCount: 1, rows: [{ id: 'deleted' }] }
    const rows =
      {
        users: journal.users.map(user => ({ ...user, lifecycle_state: 'active' })),
        profiles: journal.users.map(user => ({ user_id: user.id, display_name: user.name })),
        teams: [journal.team],
        team_members: journal.users.map(user => ({
          user_id: user.id,
          team_id: journal.team.id,
          role: 'member',
          status: 'active',
        })),
        user_agents: journal.grants.agents.map(resource => ({
          user_id: journal.users[0].id,
          resource,
        })),
        user_contexts: journal.grants.contexts.map(resource => ({
          user_id: journal.users[0].id,
          resource,
        })),
        user_workflow_triggers: [
          {
            user_id: journal.users[0].id,
            recipe_namespace: journal.grants.workflow.namespace,
            recipe_name: journal.grants.workflow.name,
          },
        ],
        ...overrides,
      }[table] ?? []
    return { rows, rowCount: rows.length }
  }
}

test('creation is atomic, journals random IDs before mutation, and only grants authorized user', async () => {
  const { state, adapters } = harness()
  const original = adapters.withTransaction
  adapters.withTransaction = work => {
    assert.equal(state.journal[0].status, 'creation-pending')
    assert.equal(state.journal[0].users.length, 2)
    return original(work)
  }
  const journal = await createFixtureIdentities(input, adapters)
  assert.equal(journal.status, 'created')
  assert.equal(state.commits, 1)
  assert.equal(state.calls.filter(call => call.sql.includes('INSERT INTO users(')).length, 2)
  const grants = state.calls.filter(call => /INSERT INTO user_(agents|contexts)/.test(call.sql))
  assert.equal(grants.length, 8)
  assert.ok(grants.every(call => call.values[0] === journal.users[0].id))
  assert.ok(
    state.calls.every(
      call =>
        !/ON CONFLICT|invitations|subscription|connection|UPDATE users|INSERT INTO team_(agents|contexts)/i.test(
          call.sql
        )
    )
  )
  const workflow = state.calls.find(call =>
    call.sql.startsWith('INSERT INTO user_workflow_triggers')
  )
  assert.deepEqual(workflow.values, [journal.users[0].id, 'sandbox-recipes', `${run}-recipe`])
  assert.ok(state.calls.some(call => call.sql.startsWith('INSERT INTO trigger_grants_audit')))
  assert.equal(state.events[0].changes.length, 13)
})

test('environment, run, scenario, synthetic email and password gates precede mutations', async () => {
  for (const mutate of [
    (i, a) => {
      a.env = { ...env, NODE_ENV: 'production' }
    },
    (i, a) => {
      a.env = { ...env, EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '0' }
    },
    (i, a) => {
      a.env = { ...env, APPROVED_TOOLS_RUN_ID: 'other' }
    },
    i => {
      i.context = 'foreign'
    },
    i => {
      i.userEmail = 'existing@example.test'
    },
    i => {
      i.unauthorizedEmail = i.userEmail
    },
    i => {
      i.userPassword = 'x'.repeat(73)
    },
    i => {
      i.scenarios[0].agentName = 'foreign-agent'
    },
    i => {
      i.scenarios.push(i.scenarios[0])
    },
  ]) {
    const { state, adapters } = harness()
    const value = structuredClone(input)
    mutate(value, adapters)
    await assert.rejects(createFixtureIdentities(value, adapters))
    assert.equal(state.calls.length, 0)
    assert.equal(state.journal.length, 0)
  }
})

test('duplicate/query and audit failures roll back without discarding the intent journal', async () => {
  for (const kind of ['query', 'audit']) {
    const { state, adapters } = harness()
    if (kind === 'query') state.failQuery = sql => sql.includes('INSERT INTO teams')
    else state.auditFailure = true
    await assert.rejects(createFixtureIdentities(input, adapters), error => {
      assert.match(error.message, /recover using/)
      assert.deepEqual(error.cause, { name: 'Error' })
      return true
    })
    assert.equal(state.committed.length, 0)
    assert.equal(state.rollbacks, 1)
    assert.equal(state.journal.at(-1).status, 'recovery-required')
    assert.deepEqual(state.journal[0].users, state.journal.at(-1).users)
  }
})

test('failure diagnostics expose bounded class/code fields and redact messages', () => {
  const error = Object.assign(new Error('token=secret sql=SELECT password'), {
    code: '23505',
    cause: new Error('nested credential=secret'),
  })
  assert.deepEqual(describeFixtureError(error), {
    name: 'Error',
    code: '23505',
    cause: { name: 'Error' },
  })
  assert.deepEqual(describeFixtureError({ name: 'Error', code: 'not-safe', message: 'secret' }), {
    name: 'Error',
  })
})

test('lost commit acknowledgement retains exact IDs rather than retrying insertion', async () => {
  const { state, adapters } = harness()
  state.commitLost = true
  await assert.rejects(createFixtureIdentities(input, adapters), /recover using/)
  assert.equal(state.commits, 1)
  assert.equal(state.journal.at(-1).status, 'recovery-required')
  assert.deepEqual(state.journal[0].users, state.journal.at(-1).users)
})

test('ordinary cleanup locks ownership and dependencies and preserves audit behavior', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.calls = []
  state.respond = cleanupRows(journal)
  const outcome = await cleanupFixtureIdentities(input, journal, adapters)
  assert.deepEqual(outcome, { outcome: 'deleted-with-audit-retained', auditRetention: 'preserved' })
  assert.equal(journal.status, 'cleaned')
  const deletes = state.calls.filter(call => call.sql.startsWith('DELETE'))
  assert.equal(deletes.length, 3)
  assert.deepEqual(deletes[0].values, [
    journal.users[0].id,
    journal.users[0].email,
    journal.users[0].name,
  ])
  assert.ok(
    state.calls
      .filter(call => call.sql.startsWith('SELECT'))
      .every(call => call.sql.includes('FOR UPDATE'))
  )
  assert.equal(
    state.calls.filter(call => call.sql.startsWith('UPDATE workflow_approval_medium_')).length,
    2
  )
  assert.ok(state.events.at(-1).changes.every(change => change.action === 'revoke'))
})

test('cleanup refuses foreign ownership, memberships, grants, invitations and retained links before mutation', async () => {
  for (const makeOverride of [
    j => ({
      users: j.users.map(user => ({ ...user, name: 'foreign', lifecycle_state: 'active' })),
    }),
    j => ({ profiles: j.users.map(user => ({ user_id: user.id, display_name: 'foreign' })) }),
    () => ({
      team_members: [{ team_id: 'foreign', user_id: 'foreign', role: 'admin', status: 'active' }],
    }),
    j => ({ user_agents: [{ user_id: j.users[1].id, resource: j.grants.agents[0] }] }),
    j => ({ team_contexts: [{ team_id: j.team.id }] }),
    j => ({
      user_workflow_triggers: [
        { user_id: j.users[0].id, recipe_namespace: 'foreign', recipe_name: 'foreign' },
      ],
    }),
    j => ({ team_workflow_triggers: [{ team_id: j.team.id }] }),
    j => ({ gfs_desktop_operator_links: [{ user_id: j.users[0].id }] }),
    () => ({ invitations: [{ id: 'retained' }] }),
    () => ({ invitation_teams: [{ invitation_id: 'retained' }] }),
  ]) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    state.calls = []
    state.respond = cleanupRows(journal, makeOverride(journal))
    await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
    assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
    assert.equal(journal.status, 'recovery-required')
  }
})

test('journal tampering is rejected before DB access; exact absent IDs support recovery', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.calls = []
  const foreign = structuredClone(journal)
  foreign.users[0].email = 'foreign@example.test'
  await assert.rejects(cleanupFixtureIdentities(input, foreign, adapters), /ownership/)
  assert.equal(state.calls.length, 0)
  state.respond = () => ({ rows: [], rowCount: 0 })
  assert.equal(
    (await cleanupFixtureIdentities(input, journal, adapters)).outcome,
    'recorded-identities-absent'
  )
  assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
})

test('cleanup deletion failure rolls back and leaves recovery journal', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.committed = []
  state.failQuery = sql => sql.startsWith('DELETE FROM teams')
  await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
  assert.equal(state.committed.length, 0)
  assert.equal(journal.status, 'recovery-required')
})

function connectionEvidence(journal) {
  return {
    scenario: '83',
    fixtureUserId: journal.users[0].id,
    id: '11111111-2222-4333-8444-555555555555',
    connectionKey: 'codex-0123456789abcdef',
    displayName: `Codex fixture 83 ${run}`,
    createdBy: null,
  }
}

function connectionRow(evidence) {
  return {
    id: evidence.id,
    connection_key: evidence.connectionKey,
    display_name: evidence.displayName,
    created_by: evidence.createdBy,
    status: 'connected',
    revoked_at: null,
  }
}

test('public UI connection evidence binds exact response ID and experiment without inventing creator identity', async () => {
  const { adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  const evidence = connectionEvidence(journal)
  recordFixtureConnection(input, journal, { env }, evidence)
  assert.deepEqual(journal.connections, [evidence])
  assert.throws(() => recordFixtureConnection(input, journal, { env }, evidence), /Duplicate/)
  for (const patch of [
    { id: 'invalid' },
    { displayName: 'unrelated subscription' },
    { connectionKey: 'deployment-default' },
    { createdBy: journal.users[0].id },
    { fixtureUserId: journal.users[1].id },
    { extra: 'unexpected' },
  ]) {
    const fresh = structuredClone(journal)
    fresh.connections = []
    assert.throws(
      () => recordFixtureConnection(input, fresh, { env }, { ...evidence, ...patch }),
      /evidence/
    )
    assert.deepEqual(fresh.connections, [])
  }
})

test('cleanup uses real revocation and union adapters under the same transaction and preserves tombstones', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  const evidence = connectionEvidence(journal)
  recordFixtureConnection(input, journal, { env }, evidence)
  state.respond = cleanupRows(journal, {
    codex_subscription_connections: [connectionRow(evidence)],
  })
  const actions = []
  adapters.revokeCodexSubscriptionConnection = async (db, key) => {
    assert.equal(db, state.db)
    assert.equal(key, evidence.connectionKey)
    actions.push('revoke')
    return { id: evidence.id, connectionKey: key, status: 'revoked', revokedAt: new Date() }
  }
  adapters.rebuildLiveCodexUnionAllowlist = async db => {
    assert.equal(db, state.db)
    actions.push('rebuild')
  }
  await cleanupFixtureIdentities(input, journal, adapters)
  assert.deepEqual(actions, ['revoke', 'rebuild'])
  assert.ok(!state.calls.some(call => /DELETE FROM codex_/.test(call.sql)))
  assert.deepEqual(journal.connections, [evidence])
})

test('unrecorded, replaced or foreign same-name connections block cleanup before any revocation', async () => {
  for (const kind of [
    'unrecorded',
    'replaced',
    'renamed',
    'creator-changed',
    'missing',
    'same-key-replacement',
  ]) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    const evidence = connectionEvidence(journal)
    if (kind !== 'unrecorded') recordFixtureConnection(input, journal, { env }, evidence)
    const row = connectionRow(evidence)
    if (kind === 'replaced') row.id = '11111111-2222-4333-8444-666666666666'
    if (kind === 'renamed') row.display_name = 'foreign'
    if (kind === 'creator-changed') row.created_by = journal.users[1].id
    const rows = kind === 'missing' ? [] : [row]
    if (kind === 'same-key-replacement')
      rows.push({ ...row, id: '11111111-2222-4333-8444-666666666666' })
    state.respond = cleanupRows(journal, { codex_subscription_connections: rows })
    state.calls = []
    adapters.revokeCodexSubscriptionConnection = async () => assert.fail('Unowned revocation')
    adapters.rebuildLiveCodexUnionAllowlist = async () => assert.fail('Unexpected rebuild')
    await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
    assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
    assert.equal(journal.status, 'recovery-required')
  }
})

test('already-revoked response IDs support retry but adapter failures retain recovery journal', async () => {
  for (const mode of ['retained', 'revoke-fails', 'wrong-result', 'union-fails']) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    const evidence = connectionEvidence(journal)
    recordFixtureConnection(input, journal, { env }, evidence)
    const row = connectionRow(evidence)
    if (mode === 'retained') Object.assign(row, { status: 'revoked', revoked_at: new Date() })
    state.respond = cleanupRows(journal, { codex_subscription_connections: [row] })
    state.committed = []
    adapters.revokeCodexSubscriptionConnection = async () => {
      if (mode === 'retained') assert.fail('Repeated revocation')
      if (mode === 'revoke-fails') throw new Error('synthetic failure')
      return {
        id: mode === 'wrong-result' ? 'foreign' : evidence.id,
        connectionKey: evidence.connectionKey,
        status: 'revoked',
        revokedAt: new Date(),
      }
    }
    adapters.rebuildLiveCodexUnionAllowlist = async () => {
      if (mode === 'union-fails') throw new Error('synthetic failure')
    }
    if (mode === 'retained') {
      await cleanupFixtureIdentities(input, journal, adapters)
      assert.equal(journal.status, 'cleaned')
    } else {
      await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
      assert.equal(state.committed.length, 0)
      assert.equal(journal.status, 'recovery-required')
    }
  }
})

test('publication is mandatory and cleanup cannot commit without an installed adapter', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  delete adapters.publishRuntimeAllowlist
  state.calls = []
  await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /runtime publication/)
  assert.equal(state.calls.length, 0)
})

test('controller-removed workflow grant permits cleanup without claiming a second revocation', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.calls = []
  state.events = []
  state.respond = cleanupRows(journal, { user_workflow_triggers: [] })
  await cleanupFixtureIdentities(input, journal, adapters)
  assert.equal(journal.status, 'cleaned')
  assert.equal(state.publications, 1)
  assert.ok(state.calls.every(call => !call.sql.includes('INSERT INTO trigger_grants_audit')))
  assert.equal(state.events.length, 1)
  assert.equal(state.events[0].changes.length, 12)
  assert.ok(
    state.events[0].changes.every(change => change.resourceClass !== 'workflow_trigger_access')
  )
})

test('optional workflow grant cannot belong to the negative user or another recipe', async () => {
  for (const changed of ['user', 'recipe']) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    state.calls = []
    state.respond = cleanupRows(journal, {
      user_workflow_triggers: [
        {
          user_id: changed === 'user' ? journal.users[1].id : journal.users[0].id,
          recipe_namespace: journal.grants.workflow.namespace,
          recipe_name: changed === 'recipe' ? 'foreign-recipe' : journal.grants.workflow.name,
        },
      ],
    })
    await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
    assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
    assert.equal(state.publications, 0)
  }
})

test('postcommit publication failure keeps recovery journal and absent-ID retry republishes before cleaned', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.publicationFailure = true
  await assert.rejects(cleanupFixtureIdentities(input, journal, adapters), /retain journal/)
  assert.equal(state.commits, 2, 'identity cleanup already committed')
  assert.equal(state.rollbacks, 0, 'publication failure cannot roll back committed DB work')
  assert.equal(state.publications, 1)
  assert.equal(journal.status, 'recovery-required')
  assert.ok(state.journal.every(value => value.status !== 'cleaned'))
  state.respond = () => ({ rows: [], rowCount: 0 })
  state.publicationFailure = false
  const save = adapters.saveJournal
  adapters.saveJournal = async value => {
    if (value.status === 'cleaned') assert.equal(state.publications, 2)
    await save(value)
  }
  const result = await cleanupFixtureIdentities(input, journal, adapters)
  assert.equal(result.outcome, 'recorded-identities-absent')
  assert.equal(state.publications, 2)
  assert.equal(journal.status, 'cleaned')
})
