import { randomUUID } from 'node:crypto'

const labels = ['83', '150', '250', 'workflow']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const safeErrorName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const safeErrorCode = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/

// Fixture errors can cross the container boundary. Preserve only bounded
// class/code fields: messages may contain SQL, credentials, tokens, or identity
// data. Nested causes remain structured and bounded without exposing raw text.
export function describeFixtureError(error) {
  const value = error && typeof error === 'object' ? error : {}
  const name = safeErrorName.test(value.name ?? '') ? value.name : 'UnknownError'
  const code = safeErrorCode.test(value.code ?? '') ? value.code : undefined
  const cause = value.cause && value.cause !== error ? describeFixtureError(value.cause) : undefined
  return { name, ...(code ? { code } : {}), ...(cause ? { cause } : {}) }
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function binding(input, env) {
  requireValue(/^approved-tools-[a-f0-9]{12}$/.test(input?.run ?? ''), 'Invalid fixture run')
  requireValue(
    input.mode === 'deterministic' &&
      env.NODE_ENV === 'test' &&
      env.EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE === '1' &&
      env.APPROVED_TOOLS_RUN_ID === input.run &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.profile ?? '') &&
      input.context === input.profile &&
      env.MINIKUBE_PROFILE === input.profile &&
      env.CONTROL_API_REAL_PG_CONTEXT === input.context,
    'Fixture environment binding mismatch'
  )
  return { mode: input.mode, run: input.run, profile: input.profile, context: input.context }
}

function identities(run) {
  return [run, `${run}-unauthorized`].map(name => ({ name, email: `${name}@example.test` }))
}

function scenarioGrants(input) {
  requireValue(
    Array.isArray(input.scenarios) && input.scenarios.length === 4,
    'Expected four scenarios'
  )
  const expected = labels.map(label => ({
    runId: `${input.run}-${label}`,
    agentName: `${input.run}-agent-${label}`,
    contextName: `${input.run}-context-${label}`,
  }))
  for (const [index, value] of expected.entries()) {
    requireValue(
      Object.entries(value).every(([key, item]) => input.scenarios[index]?.[key] === item),
      'Scenario ownership mismatch'
    )
  }
  return {
    agents: expected.map(value => value.agentName),
    contexts: expected.map(value => value.contextName),
    workflow: { namespace: 'sandbox-recipes', name: `${input.run}-recipe` },
  }
}

function validateJournal(journal, input, env) {
  const scope = binding(input, env)
  requireValue(
    journal &&
      Object.keys(journal).every(key =>
        [
          'version',
          'mode',
          'run',
          'profile',
          'context',
          'status',
          'users',
          'team',
          'grants',
          'connections',
          'cleanupOutcome',
        ].includes(key)
      ),
    'Unexpected identity journal fields'
  )
  requireValue(
    journal?.version === 1 && Object.entries(scope).every(([key, value]) => journal[key] === value),
    'Identity journal binding mismatch'
  )
  const expected = identities(input.run)
  requireValue(
    Array.isArray(journal.users) &&
      journal.users.length === 2 &&
      journal.users.every(
        (user, index) =>
          Object.keys(user).length === 3 &&
          uuid.test(user.id ?? '') &&
          user.name === expected[index].name &&
          user.email === expected[index].email
      ) &&
      uuid.test(journal.team?.id ?? '') &&
      Object.keys(journal.team).length === 2 &&
      journal.team.name === `${input.run}-team` &&
      new Set([...journal.users.map(user => user.id), journal.team.id]).size === 3,
    'Invalid recorded identity ownership'
  )
  const grants = scenarioGrants(input)
  requireValue(JSON.stringify(journal.grants) === JSON.stringify(grants), 'Journal grant mismatch')
  validateConnectionEvidence(journal)
  requireValue(
    ['creation-pending', 'created', 'recovery-required', 'cleanup-pending', 'cleaned'].includes(
      journal.status
    ),
    'Invalid identity journal status'
  )
  requireValue(
    journal.cleanupOutcome === undefined ||
      ['recorded-identities-absent', 'deleted-with-audit-retained'].includes(
        journal.cleanupOutcome
      ),
    'Invalid cleanup outcome'
  )
  return grants
}

async function persist(save, journal) {
  // Pass a detached snapshot: adapters cannot accidentally persist later mutations.
  await save(structuredClone(journal))
}

// Allocate public fixture identity metadata on the host before remote mutation.
export function createFixtureIdentityJournal(input, { env }) {
  const scope = binding(input, env)
  return {
    version: 1,
    ...scope,
    status: 'creation-pending',
    users: identities(input.run).map(user => ({ ...user, id: randomUUID() })),
    team: { id: randomUUID(), name: `${input.run}-team` },
    grants: scenarioGrants(input),
    connections: [],
  }
}

function validateConnectionEvidence(journal) {
  requireValue(
    Array.isArray(journal.connections) && journal.connections.length <= 4,
    'Connection journal is required'
  )
  const fields = ['scenario', 'fixtureUserId', 'id', 'connectionKey', 'displayName', 'createdBy']
  for (const connection of journal.connections) {
    requireValue(
      connection &&
        Object.keys(connection).length === fields.length &&
        Object.keys(connection).every(key => fields.includes(key)) &&
        labels.includes(connection.scenario) &&
        uuid.test(connection.id ?? '') &&
        /^codex-[a-f0-9]{16}$/.test(connection.connectionKey ?? '') &&
        connection.displayName === `Codex fixture ${connection.scenario} ${journal.run}` &&
        connection.fixtureUserId === journal.users[0].id &&
        connection.createdBy === null,
      'Invalid public connection creation evidence'
    )
  }
  for (const field of ['scenario', 'id', 'connectionKey'])
    requireValue(
      new Set(journal.connections.map(value => value[field])).size === journal.connections.length,
      'Duplicate connection creation evidence'
    )
}

/** Called on the host with safe fields from the successful visible POST response.
 * fixtureUserId associates the experiment; it does not claim that Desktop user
 * created the connection. The real admin creation route stores created_by=NULL.
 * Persist immediately. A lost POST response is not recoverable by name adoption.
 */
export function recordFixtureConnection(input, journal, { env }, evidence) {
  validateJournal(journal, input, env)
  requireValue(
    journal.status === 'created',
    'Identity creation must finish before UI grant creation'
  )
  const proposed = structuredClone(journal)
  proposed.connections.push(structuredClone(evidence))
  validateConnectionEvidence(proposed)
  journal.connections = proposed.connections
  return journal
}

async function revokeRecordedConnections(db, journal, revoke, rebuild) {
  const expectedNames = labels.map(label => `Codex fixture ${label} ${journal.run}`)
  // This bounded name query detects unjournaled POST outcomes only. Names never
  // supply deletion/revocation authority; every returned row needs recorded ID.
  const rows = (
    await db.query(
      `SELECT id::text, connection_key, display_name, created_by, status, revoked_at
    FROM codex_subscription_connections WHERE connection_key = ANY($1::text[])
      OR display_name = ANY($2::text[]) ORDER BY id FOR UPDATE`,
      [journal.connections.map(value => value.connectionKey), expectedNames]
    )
  ).rows
  requireValue(
    rows.length === journal.connections.length &&
      rows.every(row =>
        journal.connections.some(
          expected =>
            expected.id === row.id &&
            expected.connectionKey === row.connection_key &&
            expected.displayName === row.display_name &&
            expected.createdBy === row.created_by
        )
      ),
    'Unrecorded or changed connection; retain identities for recovery'
  )
  if (!rows.length) return
  requireValue(
    typeof revoke === 'function' && typeof rebuild === 'function',
    'Normal connection revocation and catalog adapters are required'
  )
  for (const row of rows) {
    if (row.revoked_at !== null) {
      requireValue(row.status === 'revoked', 'Invalid retained connection state')
      continue
    }
    const result = await revoke(db, row.connection_key)
    requireValue(
      result?.id === row.id &&
        result.connectionKey === row.connection_key &&
        result.status === 'revoked' &&
        result.revokedAt instanceof Date &&
        Number.isFinite(result.revokedAt.getTime()),
      'Connection revocation identity mismatch'
    )
  }
  await rebuild(db)
}

/**
 * Only test preconditions: fresh Desktop identities and access to fixture Hosts/Contexts.
 * No invitation, subscription consent, connection, tool approval, or business result.
 * withTransaction must use one real transaction and roll back on any callback error.
 * hashPassword is the installed bcrypt.hash; saveJournal durably saves a private owned file.
 */
export async function createFixtureIdentities(
  input,
  { env, withTransaction, hashPassword, appendPermissionEvents, saveJournal, initialJournal }
) {
  binding(input, env)
  const grants = scenarioGrants(input)
  const users = identities(input.run)
  const journal = structuredClone(initialJournal)
  validateJournal(journal, input, env)
  requireValue(
    journal.status === 'creation-pending' &&
      journal.connections.length === 0 &&
      journal.cleanupOutcome === undefined,
    'Expected a fresh identity intent'
  )
  requireValue(
    input.userEmail === users[0].email && input.unauthorizedEmail === users[1].email,
    'Expected exact run-bound synthetic emails'
  )
  const passwords = [input.userPassword, input.unauthorizedPassword]
  requireValue(
    passwords.every(
      value =>
        typeof value === 'string' &&
        value === value.trim() &&
        value.length >= 12 &&
        Buffer.byteLength(value, 'utf8') <= 72 &&
        !/[\u0000-\u001f\u007f]/.test(value)
    ),
    'Invalid fixture password'
  )
  requireValue(
    typeof appendPermissionEvents === 'function' && typeof saveJournal === 'function',
    'Audit and durable journal adapters are required'
  )
  const hashes = await Promise.all(passwords.map(value => hashPassword(value, 12)))
  requireValue(
    hashes.every(
      value => typeof value === 'string' && /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(value)
    ),
    'Expected installed bcrypt password hashes'
  )
  await persist(saveJournal, journal)
  try {
    await withTransaction(async db => {
      await db.query("SET LOCAL statement_timeout = '15s'")
      await db.query("SET LOCAL lock_timeout = '5s'")
      for (const [index, user] of journal.users.entries()) {
        await db.query(
          `INSERT INTO users(id, email, name, password_hash, password_set_at)
          VALUES ($1::uuid, $2, $3, $4, NOW())`,
          [user.id, user.email, user.name, hashes[index]]
        )
        await db.query('INSERT INTO profiles(user_id, display_name) VALUES ($1::uuid, $2)', [
          user.id,
          user.name,
        ])
      }
      await db.query('INSERT INTO teams(id, name) VALUES ($1::uuid, $2)', [
        journal.team.id,
        journal.team.name,
      ])
      for (const user of journal.users) {
        await db.query(
          `INSERT INTO team_members(team_id, user_id, role, status)
          VALUES ($1::uuid, $2::uuid, 'member', 'active')`,
          [journal.team.id, user.id]
        )
      }
      // No team grants: sharing the empty team must not authorize the negative user.
      const userId = journal.users[0].id
      for (const agent of grants.agents)
        await db.query('INSERT INTO user_agents(user_id, agent_name) VALUES ($1::uuid, $2)', [
          userId,
          agent,
        ])
      for (const context of grants.contexts)
        await db.query('INSERT INTO user_contexts(user_id, context_id) VALUES ($1::uuid, $2)', [
          userId,
          context,
        ])
      // Current schema consolidates recipe discovery/approval eligibility into
      // user_workflow_triggers; the legacy allowed-users table was dropped.
      await db.query(
        `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
        VALUES ($1::uuid, $2, $3)`,
        [userId, grants.workflow.namespace, grants.workflow.name]
      )
      await appendFixturePermissions(db, journal, 'grant', appendPermissionEvents, true)
    })
    journal.status = 'created'
    await persist(saveJournal, journal)
    return journal
  } catch (error) {
    // A failed COMMIT acknowledgement is ambiguous. Recorded random IDs permit
    // recovery without inferring ownership from a later same-email lookup.
    journal.status = 'recovery-required'
    await persist(saveJournal, journal)
    throw new Error('Fixture creation failed; recover using the recorded identity journal', {
      cause: describeFixtureError(error),
    })
  }
}

function permissionEvents(journal, action, includeWorkflow) {
  const subject = { kind: 'user', id: journal.users[0].id }
  return {
    operatorSub: subject.id,
    operatorKind: 'platform_user',
    requestId: journal.run,
    changes: [
      ...journal.users.flatMap(user => [
        {
          action,
          resourceClass: 'platform_user_access',
          resourceRef: `platform_user:${user.id}`,
          subject: { kind: 'user', id: user.id },
          status: action === 'grant' ? 'account_created' : 'account_deleted',
        },
        {
          action,
          resourceClass: 'team_membership',
          resourceRef: `team_membership:${journal.team.id}:role:member`,
          subject: { kind: 'user', id: user.id },
          teamId: journal.team.id,
        },
      ]),
      ...journal.grants.agents.map(agent => ({
        action,
        resourceClass: 'agent_access',
        resourceRef: `agent:${agent}`,
        subject,
      })),
      ...journal.grants.contexts.map(context => ({
        action,
        resourceClass: 'context_access',
        resourceRef: `context:${context}`,
        subject,
      })),
      ...(includeWorkflow
        ? [
            {
              action,
              resourceClass: 'workflow_trigger_access',
              resourceRef: `workflow_recipe:${journal.grants.workflow.namespace}/${journal.grants.workflow.name}`,
              subject,
              namespace: journal.grants.workflow.namespace,
            },
          ]
        : []),
    ],
  }
}

async function appendFixturePermissions(db, journal, action, append, includeWorkflow) {
  const events = permissionEvents(journal, action, includeWorkflow)
  events.operationId = randomUUID()
  if (!includeWorkflow) {
    await append(db, events)
    return
  }
  const id = journal.users[0].id
  await db.query(
    `INSERT INTO trigger_grants_audit(operator_user_id, target_user_id,
    recipe_namespace, recipe_name, action, payload_json)
    VALUES ($1::uuid, $1::uuid, $2, $3, $4, $5::jsonb)`,
    [
      id,
      journal.grants.workflow.namespace,
      journal.grants.workflow.name,
      action,
      JSON.stringify({
        before: action === 'grant' ? [] : [id],
        after: action === 'grant' ? [id] : [],
        administrative_operation_id: events.operationId,
      }),
    ]
  )
  events.changes.at(-1).sourceAuditRef =
    `trigger_grants_audit:operation:${events.operationId}:action:${action}`
  await append(db, events)
}

/**
 * Legacy deletion is permitted only for fresh active users with no operator-link
 * history, matching adminDeleteUser's retention boundary. Retained-history cases
 * fail closed for governed retirement; no lifecycle history is erased here.
 * Parent FOR UPDATE locks also block new FK-dependent grants/memberships while
 * existing dependent rows are locked and checked within this same transaction.
 */
export async function cleanupFixtureIdentities(
  input,
  journal,
  {
    env,
    withTransaction,
    appendPermissionEvents,
    saveJournal,
    revokeCodexSubscriptionConnection,
    rebuildLiveCodexUnionAllowlist,
    publishRuntimeAllowlist,
  }
) {
  const grants = validateJournal(journal, input, env)
  requireValue(
    typeof appendPermissionEvents === 'function' &&
      typeof saveJournal === 'function' &&
      typeof publishRuntimeAllowlist === 'function',
    'Audit, durable journal and runtime publication adapters are required'
  )
  journal.status = 'cleanup-pending'
  await persist(saveJournal, journal)
  try {
    const outcome = await withTransaction(async db => {
      await db.query("SET LOCAL statement_timeout = '15s'")
      await db.query("SET LOCAL lock_timeout = '5s'")
      const ids = journal.users.map(user => user.id)
      const users = (
        await db.query(
          `SELECT id::text, email, name, lifecycle_state FROM users
        WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [ids]
        )
      ).rows
      const teams = (
        await db.query('SELECT id::text, name FROM teams WHERE id = $1::uuid FOR UPDATE', [
          journal.team.id,
        ])
      ).rows
      if (!users.length && !teams.length) {
        await revokeRecordedConnections(
          db,
          journal,
          revokeCodexSubscriptionConnection,
          rebuildLiveCodexUnionAllowlist
        )
        return 'recorded-identities-absent'
      }
      requireValue(
        users.length === 2 &&
          teams.length === 1 &&
          teams[0].name === journal.team.name &&
          users.every(
            user =>
              journal.users.some(
                expected =>
                  expected.id === user.id &&
                  expected.name === user.name &&
                  expected.email === user.email
              ) && user.lifecycle_state === 'active'
          ),
        'Identity ownership changed'
      )
      const profiles = (
        await db.query(
          'SELECT user_id::text, display_name FROM profiles WHERE user_id = ANY($1::uuid[]) FOR UPDATE',
          [ids]
        )
      ).rows
      requireValue(
        profiles.length === 2 &&
          profiles.every(profile =>
            journal.users.some(
              user => user.id === profile.user_id && user.name === profile.display_name
            )
          ),
        'Profile ownership changed'
      )
      const members = (
        await db.query(
          `SELECT team_id::text, user_id::text, role, status FROM team_members
        WHERE team_id = $1::uuid OR user_id = ANY($2::uuid[]) FOR UPDATE`,
          [journal.team.id, ids]
        )
      ).rows
      requireValue(
        members.length === 2 &&
          members.every(
            member =>
              member.team_id === journal.team.id &&
              ids.includes(member.user_id) &&
              member.role === 'member' &&
              member.status === 'active'
          ),
        'Unrelated membership or changed role'
      )
      for (const [table, column, expected] of [
        ['user_agents', 'agent_name', grants.agents],
        ['user_contexts', 'context_id', grants.contexts],
      ]) {
        const rows = (
          await db.query(
            `SELECT user_id::text, ${column} AS resource FROM ${table}
          WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
            [ids]
          )
        ).rows
        requireValue(
          rows.length === expected.length &&
            new Set(rows.map(row => row.resource)).size === expected.length &&
            rows.every(row => row.user_id === ids[0] && expected.includes(row.resource)),
          'Unrelated or changed user grants'
        )
      }
      const workflowRows = (
        await db.query(
          `SELECT user_id::text, recipe_namespace, recipe_name
        FROM user_workflow_triggers WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
          [ids]
        )
      ).rows
      requireValue(
        workflowRows.length <= 1 &&
          workflowRows.every(
            row =>
              row.user_id === ids[0] &&
              row.recipe_namespace === grants.workflow.namespace &&
              row.recipe_name === grants.workflow.name
          ),
        'Unrelated or changed workflow grants'
      )
      for (const table of [
        'team_agents',
        'team_contexts',
        'team_workflow_triggers',
        'workflow_recipe_allowed_teams',
      ]) {
        const rows = (
          await db.query(`SELECT team_id FROM ${table} WHERE team_id = $1::uuid FOR UPDATE`, [
            journal.team.id,
          ])
        ).rows
        requireValue(rows.length === 0, 'Unrelated team grants')
      }
      const links = (
        await db.query(
          'SELECT user_id FROM gfs_desktop_operator_links WHERE user_id = ANY($1::uuid[]) FOR UPDATE',
          [ids]
        )
      ).rows
      requireValue(
        links.length === 0,
        'Operator-link history requires governed retirement; identities retained'
      )
      // Invitations are not created by this helper. Do not cascade unrelated ones.
      const invitations = (
        await db.query(
          `SELECT id FROM invitations WHERE team_id = $1::uuid
        OR accepted_user_id = ANY($2::uuid[]) OR email = ANY($3::text[]) FOR UPDATE`,
          [journal.team.id, ids, journal.users.map(user => user.email)]
        )
      ).rows
      const assignments = (
        await db.query(
          'SELECT invitation_id FROM invitation_teams WHERE team_id = $1::uuid FOR UPDATE',
          [journal.team.id]
        )
      ).rows
      requireValue(
        !invitations.length && !assignments.length,
        'Unexpected invitations; identities retained'
      )
      await revokeRecordedConnections(
        db,
        journal,
        revokeCodexSubscriptionConnection,
        rebuildLiveCodexUnionAllowlist
      )
      // Preserve the normal account-deletion revocation behavior before deleting.
      await db.query(
        `UPDATE workflow_approval_medium_accounts SET disabled_at = COALESCE(disabled_at, NOW()),
        updated_at = NOW() WHERE user_id = ANY($1::uuid[]) AND disabled_at IS NULL`,
        [ids]
      )
      await db.query(
        `UPDATE workflow_approval_medium_challenges SET consumed_at = COALESCE(consumed_at, NOW()),
        expires_at = LEAST(expires_at, NOW()) WHERE user_id = ANY($1::uuid[]) AND consumed_at IS NULL`,
        [ids]
      )
      // WRC reconcileDelete may already have removed the exact recipe grant.
      // Only claim a workflow revocation when this transaction removes a row.
      await appendFixturePermissions(
        db,
        journal,
        'revoke',
        appendPermissionEvents,
        workflowRows.length === 1
      )
      for (const user of journal.users) {
        const result = await db.query(
          `DELETE FROM users WHERE id = $1::uuid AND email = $2 AND name = $3
          AND lifecycle_state = 'active' RETURNING id`,
          [user.id, user.email, user.name]
        )
        requireValue(result.rowCount === 1, 'User deletion ownership mismatch')
      }
      const result = await db.query(
        'DELETE FROM teams WHERE id = $1::uuid AND name = $2 RETURNING id',
        [journal.team.id, journal.team.name]
      )
      requireValue(result.rowCount === 1, 'Team deletion ownership mismatch')
      return 'deleted-with-audit-retained'
    })
    // The ConfigMap writer reads committed state through its own DB client.
    // Never hold identity locks during K8s publication. Even the absent-ID retry
    // must republish: a preceding attempt may have committed then failed here.
    await publishRuntimeAllowlist()
    journal.status = 'cleaned'
    journal.cleanupOutcome = outcome
    await persist(saveJournal, journal)
    return { outcome, auditRetention: 'preserved' }
  } catch (error) {
    journal.status = 'recovery-required'
    await persist(saveJournal, journal)
    throw new Error('Fixture cleanup refused or failed; retain journal for recovery', {
      cause: describeFixtureError(error),
    })
  }
}
