import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FixtureIdentityError,
  IDENTITY_ERROR_CODES,
  IDENTITY_ERROR_PHASES,
  cleanupFixtureIdentities,
  createFixtureIdentityJournal,
  createFixtureIdentities as createRecordedFixtureIdentities,
  describeIdentityFailure,
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
  suite: 'approved-tools',
  run,
  profile: 'owned-e2e',
  context: 'owned-e2e',
  // The lane's sign-in identifier, not a `control_admin_users` column value:
  // the Control UI login trims it and resolves username or email.
  adminUsername: '  Admin@Example.test  ',
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
    // The lane's Control Admin rows the governed retirement resolves. The lane
    // sends a sign-in identifier, so the fixture resolves it through the product
    // login predicate; an empty list, a disabled row or two rows is refused.
    controlAdmins: [{ id: '99999999-9999-4999-8999-999999999999', status: 'active' }],
    retirements: [],
    retirementOutcome: 'deleted',
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
    // The governed retirement is a product adapter in the seed; this harness
    // records its exact request and never mutates users itself.
    retireDesktopUserInTransaction: async (db, request) => {
      assert.equal(db, state.db, 'retirement must use the cleanup transaction handle')
      state.retirements.push(request)
      if (state.retirementError) throw state.retirementError
      return {
        id: request.userId,
        outcome: state.retirementOutcome,
        operationId: '77777777-7777-4777-8777-777777777777',
        lifecycleVersion: null,
        replayed: false,
      }
    },
    withTransaction: async callback => {
      const pending = []
      const db = {
        query: async (sql, values = []) => {
          state.calls.push({ sql, values })
          if (state.failQuery?.(sql)) throw new Error('synthetic query failure')
          pending.push({ sql, values })
          if (sql.includes('FROM control_admin_users')) {
            const rows = state.controlAdmins
            return { rows, rowCount: rows.length }
          }
          if (state.respond) return state.respond(sql, values)
          return { rows: [], rowCount: 1 }
        },
      }
      state.db = db
      state.transactionActive = true
      if (state.transactionFailure) {
        state.transactionActive = false
        state.rollbacks++
        throw state.transactionFailure
      }
      try {
        const result = await callback(db)
        state.committed.push(...pending)
        state.commits++
        if (state.commitLost) throw new Error('commit response lost')
        if (state.commitFailure) throw state.commitFailure
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

// Resolves a rejected cleanup into its coded error, failing loudly if the
// operation unexpectedly succeeded.
async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof FixtureIdentityError, `expected a coded refusal, got ${error}`)
    return error
  }
  assert.fail('expected an identity refusal')
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

test('every pre-mutation refusal names its own closed code before any DB access', async () => {
  // One row per refusal site: the mutation applied to the input or the adapters,
  // the code the site must report, and the phase of the pre-transaction check.
  const cases = [
    [
      'invalid_provider',
      (i, a) => {
        i.provider = 'other'
      },
    ],
    [
      'invalid_run',
      i => {
        i.run = 'not-a-run'
      },
    ],
    [
      'binding_env_mismatch',
      (i, a) => {
        a.env = { ...env, NODE_ENV: 'production' }
      },
    ],
    [
      'binding_env_mismatch',
      (i, a) => {
        a.env = { ...env, EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '0' }
      },
    ],
    [
      'binding_env_mismatch',
      (i, a) => {
        a.env = { ...env, APPROVED_TOOLS_RUN_ID: 'other' }
      },
    ],
    [
      'binding_env_mismatch',
      i => {
        i.context = 'foreign'
      },
    ],
    [
      'suite_invalid',
      i => {
        i.suite = 'other'
      },
    ],
    [
      'suite_invalid',
      i => {
        delete i.suite
      },
    ],
    [
      'scenario_set_invalid',
      i => {
        i.scenarios = i.scenarios.slice(0, 2)
      },
    ],
    [
      'scenario_ownership_changed',
      i => {
        i.scenarios[0].agentName = 'foreign-agent'
      },
    ],
    [
      'scenario_set_invalid',
      i => {
        i.scenarios.push(i.scenarios[0])
      },
    ],
    [
      'identity_email_changed',
      i => {
        i.userEmail = 'existing@example.test'
      },
    ],
    [
      'identity_email_changed',
      i => {
        i.unauthorizedEmail = i.userEmail
      },
    ],
    [
      'password_invalid',
      i => {
        i.userPassword = 'x'.repeat(73)
      },
    ],
    [
      'adapter_missing',
      (i, a) => {
        delete a.appendPermissionEvents
      },
    ],
    [
      'journal_fields_invalid',
      (i, a) => {
        a.initialJournal.unexpected = true
      },
    ],
    [
      'journal_binding_mismatch',
      (i, a) => {
        a.initialJournal.run = 'approved-tools-000000000000'
      },
    ],
    [
      'identity_ownership_changed',
      (i, a) => {
        a.initialJournal.users[0].email = 'foreign@example.test'
      },
    ],
    [
      'journal_grant_mismatch',
      (i, a) => {
        a.initialJournal.grants.agents = ['foreign-agent']
      },
    ],
    [
      'connection_evidence_invalid',
      (i, a) => {
        a.initialJournal.connections.push({
          ...connectionEvidence(a.initialJournal),
          createdBy: 'x',
        })
      },
    ],
    [
      'journal_status_invalid',
      (i, a) => {
        a.initialJournal.status = 'unexpected'
      },
    ],
    [
      'cleanup_outcome_invalid',
      (i, a) => {
        a.initialJournal.cleanupOutcome = 'unexpected'
      },
    ],
  ]
  for (const [code, mutate] of cases) {
    const { state, adapters } = harness()
    adapters.initialJournal = createFixtureIdentityJournal(input, { env })
    const value = structuredClone(input)
    mutate(value, adapters)
    const error = await refusal(createRecordedFixtureIdentities(value, adapters))
    assert.equal(error.code, code, `unexpected code for ${mutate}`)
    assert.equal(error.phase, 'validate-intent')
    assert.equal(error.sqlstate, 'UNKNOWN')
    assert.equal(state.calls.length, 0)
    assert.equal(state.journal.length, 0)
  }
})

test('duplicate/query and audit failures roll back without discarding the intent journal', async () => {
  for (const kind of ['query', 'audit']) {
    const { state, adapters } = harness()
    if (kind === 'query') state.failQuery = sql => sql.includes('INSERT INTO teams')
    else state.auditFailure = true
    await assert.rejects(createFixtureIdentities(input, adapters), /recover using/)
    assert.equal(state.committed.length, 0)
    assert.equal(state.rollbacks, 1)
    assert.equal(state.journal.at(-1).status, 'recovery-required')
    assert.deepEqual(state.journal[0].users, state.journal.at(-1).users)
  }
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
  assert.equal(deletes.length, 1, 'only the journaled team is deleted directly')
  assert.match(deletes[0].sql, /^DELETE FROM teams/)
  assert.ok(
    state.calls.every(call => !/^DELETE FROM users/.test(call.sql)),
    'users are removed only by the governed retirement adapter'
  )
  assert.equal(state.retirements.length, 2)
  assert.deepEqual(
    state.retirements.map(request => request.userId),
    journal.users.map(user => user.id)
  )
  assert.ok(
    state.calls
      .filter(call => call.sql.startsWith('SELECT'))
      .every(call => call.sql.includes('FOR UPDATE') || call.sql.includes('control_admin_users'))
  )
  assert.equal(
    state.calls.filter(call => call.sql.startsWith('UPDATE workflow_approval_medium_')).length,
    2
  )
  assert.ok(state.events.at(-1).changes.every(change => change.action === 'revoke'))
})

test('every transactional cleanup refusal names its phase and that phase ran last', async () => {
  // The last recorded statement is the liveness witness for the phase: it proves
  // the refusal came from that statement group and not from an earlier check.
  const cases = [
    [
      'identity_ownership_changed',
      'lock-identities',
      /FROM teams WHERE id = \$1::uuid FOR UPDATE/,
      j => ({
        users: j.users.map(user => ({ ...user, name: 'foreign', lifecycle_state: 'active' })),
      }),
    ],
    [
      'profile_ownership_changed',
      'check-profiles',
      /FROM profiles/,
      j => ({ profiles: j.users.map(user => ({ user_id: user.id, display_name: 'foreign' })) }),
    ],
    [
      'membership_changed',
      'check-memberships',
      /FROM team_members/,
      () => ({
        team_members: [{ team_id: 'foreign', user_id: 'foreign', role: 'admin', status: 'active' }],
      }),
    ],
    [
      'user_grants_changed',
      'check-user-grants',
      /FROM user_agents/,
      j => ({ user_agents: [{ user_id: j.users[1].id, resource: j.grants.agents[0] }] }),
    ],
    [
      'workflow_grants_changed',
      'check-workflow-grants',
      /FROM user_workflow_triggers/,
      j => ({
        user_workflow_triggers: [
          { user_id: j.users[0].id, recipe_namespace: 'foreign', recipe_name: 'foreign' },
        ],
      }),
    ],
    [
      'team_grants_unrelated',
      'check-team-grants',
      /FROM team_contexts/,
      j => ({ team_contexts: [{ team_id: j.team.id }] }),
    ],
    [
      'operator_link_history',
      'check-operator-links',
      /FROM gfs_desktop_operator_links/,
      j => ({ gfs_desktop_operator_links: [{ user_id: j.users[0].id }] }),
    ],
    [
      'invitations_unexpected',
      'check-invitations',
      /FROM invitation_teams/,
      () => ({ invitations: [{ id: 'retained' }] }),
    ],
    [
      'connection_unrecorded',
      'revoke-connections',
      /FROM codex_subscription_connections/,
      () => ({
        codex_subscription_connections: [
          {
            id: '11111111-2222-4333-8444-555555555555',
            connection_key: 'codex-0123456789abcdef',
            display_name: `Codex fixture 83 ${run}`,
            created_by: null,
            status: 'connected',
            revoked_at: null,
          },
        ],
      }),
    ],
  ]
  for (const [code, phase, witness, override] of cases) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    state.calls = []
    state.respond = cleanupRows(journal, override(journal))
    const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
    assert.equal(error.code, code)
    assert.equal(error.phase, phase)
    assert.equal(error.sqlstate, 'UNKNOWN')
    assert.equal(journal.status, 'recovery-required')
    assert.match(state.calls.at(-1).sql, witness, `last statement must belong to ${phase}`)
    assert.ok(
      state.calls.every(call => !/^DELETE|^UPDATE workflow_approval_medium_/.test(call.sql)),
      `${code} must refuse before any deletion or approval-medium update`
    )
  }
})

test('an unresolvable control admin refuses the governed retirement before any deletion', async () => {
  const active = { id: '99999999-9999-4999-8999-999999999999', status: 'active' }
  // One row per refusal shape of the actor lookup. The lane's identifier is a
  // sign-in identifier, so the fixture must resolve exactly one active admin.
  const cases = [
    ['an identifier no admin row matches', []],
    ['an identifier whose only admin is disabled', [{ ...active, status: 'disabled' }]],
    [
      'an identifier two admin rows match',
      [active, { id: '88888888-8888-4888-8888-888888888888', status: 'active' }],
    ],
    ['a whitespace-only identifier', [active], '   '],
  ]
  for (const [label, controlAdmins, adminUsername] of cases) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    const cleanupInput = adminUsername === undefined ? input : { ...input, adminUsername }
    state.calls = []
    state.retirements = []
    state.controlAdmins = controlAdmins
    state.respond = cleanupRows(journal)
    const error = await refusal(cleanupFixtureIdentities(cleanupInput, journal, adapters))
    assert.equal(error.code, 'control_admin_missing', label)
    assert.equal(error.phase, 'delete-users', label)
    assert.equal(error.sqlstate, 'UNKNOWN', label)
    assert.equal(journal.status, 'recovery-required', label)
    assert.equal(state.commits, 1, 'only the fixture creation transaction committed')
    assert.equal(state.retirements.length, 0, 'no actorless retirement may be attempted')
    assert.ok(
      state.calls.every(call => !/DELETE FROM users/.test(call.sql)),
      label
    )
    // Liveness: the lookup ran inside the cleanup transaction and named the
    // trimmed identifier for every refusal shape.
    assert.match(state.calls.at(-1).sql, /FROM control_admin_users/, label)
    assert.deepEqual(state.calls.at(-1).values, [cleanupInput.adminUsername.trim()], label)
  }
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
    const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
    assert.ok(IDENTITY_ERROR_CODES.includes(error.code))
    assert.ok(IDENTITY_ERROR_PHASES.includes(error.phase))
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
  const error = await refusal(cleanupFixtureIdentities(input, foreign, adapters))
  assert.equal(error.code, 'identity_ownership_changed')
  assert.equal(error.phase, 'validate-intent')
  assert.equal(state.calls.length, 0)
  state.respond = () => ({ rows: [], rowCount: 0 })
  assert.equal(
    (await cleanupFixtureIdentities(input, journal, adapters)).outcome,
    'recorded-identities-absent'
  )
  assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
})

test('cleanup deletion failures are coded per site and roll back the journal', async () => {
  // A tombstone outcome retains an identity this fixture must remove; the
  // refusal is the user-delete site, not the team delete.
  const tombstone = harness()
  const tombstoneJournal = await createFixtureIdentities(input, tombstone.adapters)
  tombstone.state.respond = cleanupRows(tombstoneJournal)
  tombstone.state.retirementOutcome = 'retired'
  tombstone.state.committed = []
  tombstone.state.commits = 0
  const retiredError = await refusal(
    cleanupFixtureIdentities(input, tombstoneJournal, tombstone.adapters)
  )
  assert.equal(retiredError.code, 'user_delete_mismatch')
  assert.equal(retiredError.phase, 'delete-users')
  assert.equal(tombstone.state.committed.length, 0)
  assert.equal(tombstoneJournal.status, 'recovery-required')
  assert.equal(tombstone.state.retirements.length, 1, 'the refusal came from the retirement')

  const team = harness()
  const teamJournal = await createFixtureIdentities(input, team.adapters)
  const rows = cleanupRows(teamJournal)
  team.state.respond = (sql, values) =>
    sql.startsWith('DELETE FROM teams') ? { rowCount: 0, rows: [] } : rows(sql, values)
  team.state.committed = []
  team.state.commits = 0
  const teamError = await refusal(cleanupFixtureIdentities(input, teamJournal, team.adapters))
  assert.equal(teamError.code, 'team_delete_mismatch')
  assert.equal(teamError.phase, 'delete-team')
  assert.equal(team.state.committed.length, 0)
  assert.equal(teamJournal.status, 'recovery-required')
  assert.equal(team.state.retirements.length, 2, 'both users retired before the team refusal')
})

test('a database error is reported as db_error with its SQLSTATE and no message text', async () => {
  const sentinel = 'duplicate key value violates constraint e2e_never_echo_this'
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.retirementError = { code: '23503', message: sentinel }
  const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
  assert.deepEqual(
    { code: error.code, phase: error.phase, sqlstate: error.sqlstate },
    { code: 'db_error', phase: 'delete-users', sqlstate: '23503' }
  )
  assert.equal(String(error.message).includes(sentinel), false)
  assert.equal(JSON.stringify(describeIdentityFailure(error)).includes(sentinel), false)
  // Liveness: the governed retirement was entered and the actor was resolved
  // in the cleanup transaction before it failed.
  assert.equal(state.retirements.length, 1)
  assert.match(state.calls.at(-1).sql, /FROM control_admin_users/)
  assert.equal(journal.status, 'recovery-required')
})

test('a step failure without a PostgreSQL code is step_failed and keeps its phase', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  const rows = cleanupRows(journal)
  state.respond = (sql, values) => {
    if (sql.startsWith('DELETE FROM teams')) throw new Error('plain javascript fault')
    return rows(sql, values)
  }
  const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
  assert.deepEqual(
    { code: error.code, phase: error.phase, sqlstate: error.sqlstate },
    { code: 'step_failed', phase: 'delete-team', sqlstate: 'UNKNOWN' }
  )
  assert.ok(IDENTITY_ERROR_CODES.includes('step_failed'))
})

test('the commit boundary is labelled only after the transaction callback returned', async () => {
  // Callback returned, then COMMIT failed: the closed commit phase names it and
  // every inner statement is a witness that the transaction body completed.
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.commitFailure = { code: '23514', message: 'deferred constraint e2e_sentinel' }
  const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
  assert.deepEqual(
    { code: error.code, phase: error.phase, sqlstate: error.sqlstate },
    { code: 'db_error', phase: 'commit', sqlstate: '23514' }
  )
  assert.ok(state.calls.some(call => call.sql.startsWith('DELETE FROM teams')))
  assert.ok(state.calls.some(call => call.sql.startsWith('INSERT INTO trigger_grants_audit')))
  assert.equal(String(error.message).includes('e2e_sentinel'), false)

  // A JavaScript fault before the callback returned is not a COMMIT failure.
  const early = harness()
  const earlyJournal = await createFixtureIdentities(input, early.adapters)
  early.state.transactionFailure = new Error('connection reset before begin')
  const earlyError = await refusal(cleanupFixtureIdentities(input, earlyJournal, early.adapters))
  assert.deepEqual(
    { code: earlyError.code, phase: earlyError.phase, sqlstate: earlyError.sqlstate },
    { code: 'step_failed', phase: 'validate-intent', sqlstate: 'UNKNOWN' }
  )
})

test('publication failure after COMMIT is coded and republishes before cleaned', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.publicationFailure = true
  const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
  assert.deepEqual(
    { code: error.code, phase: error.phase, sqlstate: error.sqlstate },
    { code: 'step_failed', phase: 'publish-allowlist', sqlstate: 'UNKNOWN' }
  )
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
    const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
    assert.equal(error.code, 'connection_unrecorded')
    assert.equal(error.phase, 'revoke-connections')
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
      const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
      if (mode === 'wrong-result') {
        assert.equal(error.code, 'revocation_identity_mismatch')
        assert.equal(error.phase, 'revoke-connections')
      } else {
        assert.equal(error.code, 'step_failed')
        assert.equal(
          error.phase,
          mode === 'union-fails' ? 'rebuild-allowlist' : 'revoke-connections'
        )
      }
      assert.equal(state.committed.length, 0)
      assert.equal(journal.status, 'recovery-required')
    }
  }
})

test('publication is mandatory and cleanup cannot commit without an installed adapter', async () => {
  for (const adapter of ['publishRuntimeAllowlist', 'retireDesktopUserInTransaction']) {
    const { state, adapters } = harness()
    const journal = await createFixtureIdentities(input, adapters)
    delete adapters[adapter]
    state.calls = []
    const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
    assert.equal(error.code, 'adapter_missing')
    assert.equal(error.phase, 'validate-intent')
    assert.equal(state.calls.length, 0)
  }
})

test('cleanup retires every journal user through the governed adapter inside the transaction', async () => {
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.calls = []
  state.retirements = []
  state.respond = cleanupRows(journal)
  const result = await cleanupFixtureIdentities(input, journal, adapters)
  assert.deepEqual(result, {
    outcome: 'deleted-with-audit-retained',
    auditRetention: 'preserved',
  })
  // One governed retirement per journal user, with the transaction handle, the
  // resolved Control Admin, a fixed reason and a deterministic idempotency key.
  assert.equal(state.retirements.length, 2)
  assert.deepEqual(
    state.retirements.map(request => request.userId),
    journal.users.map(user => user.id)
  )
  for (const request of state.retirements) {
    assert.deepEqual(request.actor, {
      kind: 'control_admin',
      controlAdminId: state.controlAdmins[0].id,
    })
    assert.equal(request.reason, 'Approved tools E2E fixture identity cleanup')
    assert.equal(request.idempotencyKey, `approved-tools-cleanup:${run}:${request.userId}`)
    assert.equal(request.requestId, null)
  }
  // The actor lookup names the lane's sign-in identifier, trimmed, and mirrors
  // the product login predicate (`findAdminByLogin`): username or email.
  const lookup = state.calls.find(call => call.sql.includes('FROM control_admin_users'))
  assert.deepEqual(lookup.values, [input.adminUsername.trim()])
  assert.match(lookup.sql, /username = \$1\s+OR lower\(email\) = lower\(\$1\)/)
  // No raw user delete is issued by the fixture itself.
  assert.ok(state.calls.every(call => !/DELETE FROM users/.test(call.sql)))
  assert.ok(state.calls.some(call => /^DELETE FROM teams/.test(call.sql)))
})

test('a database refusal from the governed retirement keeps its SQLSTATE and phase', async () => {
  // The password-admission fence rejects a raw delete with 55000; the cleanup
  // must surface that exact classification instead of a generic failure.
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  state.respond = cleanupRows(journal)
  state.retirementError = { code: '55000' }
  state.committed = []
  state.commits = 0
  state.rollbacks = 0
  const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
  assert.deepEqual(
    { code: error.code, phase: error.phase, sqlstate: error.sqlstate },
    { code: 'db_error', phase: 'delete-users', sqlstate: '55000' }
  )
  assert.equal(journal.status, 'recovery-required')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.calls.some(call => call.sql.includes('FROM control_admin_users')))
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
    const error = await refusal(cleanupFixtureIdentities(input, journal, adapters))
    assert.equal(error.code, 'workflow_grants_changed')
    assert.equal(error.phase, 'check-workflow-grants')
    assert.ok(state.calls.every(call => !/^(DELETE|UPDATE)/.test(call.sql)))
    assert.equal(state.publications, 0)
  }
})

test('a pre-suite journal restores under approved-tools and is refused for model-step-retry', async () => {
  // A state written before the suite field existed still carries the four
  // approved-tools grants; the grants check is what binds a journal to a suite.
  const journal = await createFixtureIdentities(input, harness().adapters)
  const evidence = connectionEvidence(journal)
  recordFixtureConnection(input, journal, { env }, evidence)
  const legacy = structuredClone(journal)
  assert.equal('suite' in legacy, false)
  assert.ok(legacy.grants.workflow)

  const accepted = harness()
  accepted.state.respond = cleanupRows(legacy, {
    codex_subscription_connections: [connectionRow(evidence)],
  })
  accepted.adapters.revokeCodexSubscriptionConnection = async (db, key) => ({
    id: evidence.id,
    connectionKey: key,
    status: 'revoked',
    revokedAt: new Date(),
  })
  accepted.adapters.rebuildLiveCodexUnionAllowlist = async () => {}
  const outcome = await cleanupFixtureIdentities(input, structuredClone(legacy), accepted.adapters)
  assert.equal(outcome.outcome, 'deleted-with-audit-retained')
  assert.ok(accepted.state.calls.length > 0)

  const refusedJournal = structuredClone(legacy)
  const refused = harness()
  const error = await refusal(
    cleanupFixtureIdentities(
      { ...input, suite: 'model-step-retry', scenarios: input.scenarios.slice(0, 1) },
      refusedJournal,
      refused.adapters
    )
  )
  assert.equal(error.code, 'journal_grant_mismatch')
  assert.equal(error.phase, 'validate-intent')
  assert.equal(refusedJournal.status, journal.status)
  assert.equal(refused.state.calls.length, 0, 'the suite check runs before any DML')
})

test('the suite is required, closed, and selects the model-step-retry scenario set', async () => {
  assert.ok(Object.isFrozen(IDENTITY_ERROR_CODES))
  assert.ok(Object.isFrozen(IDENTITY_ERROR_PHASES))
  const single = {
    ...input,
    suite: 'model-step-retry',
    scenarios: input.scenarios.slice(0, 1),
  }
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(single, adapters)
  assert.deepEqual(journal.grants, {
    agents: [input.scenarios[0].agentName],
    contexts: [input.scenarios[0].contextName],
  })
  assert.equal(state.calls.filter(call => call.sql.startsWith('INSERT INTO user_agents')).length, 1)
  assert.ok(!state.calls.some(call => call.sql.startsWith('INSERT INTO user_workflow_triggers')))
  assert.throws(
    () => createFixtureIdentityJournal({ ...input, suite: 'unexpected' }, { env }),
    /Invalid fixture suite/
  )
  assert.throws(
    () => createFixtureIdentityJournal({ ...single, scenarios: input.scenarios }, { env }),
    /one model-step-retry scenario/
  )
  assert.throws(
    () =>
      createFixtureIdentityJournal({ ...input, scenarios: input.scenarios.slice(0, 1) }, { env }),
    /3 approved-tools scenarios/
  )
})

test('the live per-suite shapes own exactly their grants (#1048 MS-NW)', async () => {
  // The live base suite prepares three receipt catalogs and no workflow, so it
  // owns no WorkflowRecipe and no trigger grant.
  const base = { ...input, scenarios: input.scenarios.slice(0, 3) }
  const baseRun = harness()
  const baseJournal = await createFixtureIdentities(base, baseRun.adapters)
  assert.deepEqual(baseJournal.grants, {
    agents: input.scenarios.slice(0, 3).map(row => row.agentName),
    contexts: input.scenarios.slice(0, 3).map(row => row.contextName),
  })
  assert.equal(baseJournal.grants.workflow, undefined)
  assert.equal(
    baseRun.state.calls.filter(call => call.sql.startsWith('INSERT INTO user_workflow_triggers'))
      .length,
    0
  )
  assert.equal(
    baseRun.state.calls.filter(call => call.sql.startsWith('INSERT INTO user_agents')).length,
    3
  )

  // native-workflow prepares the one workflow agent and owns the trigger grant;
  // the base journal above is refused for it and vice versa.
  const workflow = { ...input, suite: 'native-workflow', scenarios: [input.scenarios[3]] }
  const workflowRun = harness()
  const workflowJournal = await createFixtureIdentities(workflow, workflowRun.adapters)
  assert.deepEqual(workflowJournal.grants, {
    agents: [input.scenarios[3].agentName],
    contexts: [input.scenarios[3].contextName],
    workflow: { namespace: 'sandbox-recipes', name: `${run}-recipe` },
  })
  assert.equal(
    workflowRun.state.calls.filter(call =>
      call.sql.startsWith('INSERT INTO user_workflow_triggers')
    ).length,
    1
  )
  assert.throws(
    () =>
      createFixtureIdentityJournal(
        { ...workflow, scenarios: input.scenarios.slice(0, 3) },
        { env }
      ),
    /one native-workflow scenario/
  )
  assert.throws(
    () => createFixtureIdentityJournal({ ...base, suite: 'native-workflow' }, { env }),
    /one native-workflow scenario/
  )
  // Liveness: the base suite still creates its three agents and contexts.
  assert.equal(
    baseRun.state.calls.filter(call => call.sql.startsWith('INSERT INTO user_contexts')).length,
    3
  )
})

test('Grok identity setup grants one agent and context, no workflow or connection ownership', async () => {
  const grok = {
    ...input,
    provider: 'grok',
    suite: 'model-step-retry',
    scenarios: input.scenarios.slice(0, 1),
  }
  const { state, adapters } = harness()
  const journal = await createFixtureIdentities(grok, adapters)
  assert.equal(journal.status, 'created')
  assert.deepEqual(journal.grants, {
    agents: [input.scenarios[0].agentName],
    contexts: [input.scenarios[0].contextName],
  })
  assert.deepEqual(journal.connections, [])
  assert.equal(state.calls.filter(row => row.sql.startsWith('INSERT INTO user_agents')).length, 1)
  assert.equal(
    state.calls.some(row =>
      /INSERT INTO user_workflow_triggers|subscription_connections/.test(row.sql)
    ),
    false
  )
  await cleanupFixtureIdentities(grok, journal, adapters)
  assert.equal(journal.status, 'cleaned')
  assert.equal(
    state.calls.some(row => /subscription_connections/.test(row.sql)),
    false
  )
  const broken = { ...grok, scenarios: input.scenarios }
  assert.throws(
    () => createFixtureIdentityJournal(broken, { env }),
    /one model-step-retry scenario/
  )
})

test('the reported failure payload is always the frozen triple', async () => {
  const { adapters } = harness()
  const journal = await createFixtureIdentities(input, adapters)
  assert.deepEqual(
    describeIdentityFailure(
      new FixtureIdentityError(
        'journal_grant_mismatch',
        'validate-intent',
        'UNKNOWN',
        'Journal grant mismatch'
      )
    ),
    { code: 'journal_grant_mismatch', phase: 'validate-intent', sqlstate: 'UNKNOWN' }
  )
  // A non-fixture error is classified instead of escaping the closed sets.
  assert.deepEqual(describeIdentityFailure(new Error('raw runtime text')), {
    code: 'step_failed',
    phase: 'unknown',
    sqlstate: 'UNKNOWN',
  })
  assert.deepEqual(describeIdentityFailure({ code: '55000' }), {
    code: 'db_error',
    phase: 'unknown',
    sqlstate: '55000',
  })
  assert.throws(
    () => new FixtureIdentityError('not_a_code', 'validate-intent', 'UNKNOWN', 'x'),
    /Invalid fixture identity error/
  )
  assert.throws(
    () => new FixtureIdentityError('db_error', 'not-a-phase', 'UNKNOWN', 'x'),
    /Invalid fixture identity error/
  )
  assert.throws(
    () => new FixtureIdentityError('db_error', 'commit', 'not-a-sqlstate', 'x'),
    /Invalid fixture identity error/
  )
  assert.deepEqual(
    describeIdentityFailure(new FixtureIdentityError('db_error', 'commit', '23514', 'x')),
    { code: 'db_error', phase: 'commit', sqlstate: '23514' }
  )
  assert.equal(journal.status, 'created')
})
