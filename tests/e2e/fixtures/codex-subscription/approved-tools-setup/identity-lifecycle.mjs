import { randomUUID } from 'node:crypto'

const labels = ['83', '150', '250', 'workflow']
const modelStepLabels = ['83']
// #1048 MS-NW: each suite owns its prepared scenario set. The base journeys keep
// the three receipt catalogs and own no workflow; only native-workflow owns the
// recipe and its trigger grant; model-step-retry runs the single 83-tool agent.
const suiteLabels = Object.freeze({
  'approved-tools': ['83', '150', '250'],
  'native-workflow': ['workflow'],
  'model-step-retry': modelStepLabels,
})
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sqlstatePattern = /^[0-9A-Z]{5}$/
const unclassifiedSqlstate = 'UNKNOWN'

function suiteIsSingle(suite) {
  return suite === 'model-step-retry'
}

// Closed set of reasons a fixture identity operation can fail for. One code per
// refusal site; `db_error` and `step_failed` are the two generic classifications
// for an unexpected error raised inside a step, `control_admin_missing` refuses
// a governed retirement whose lane sign-in identifier does not resolve to
// exactly one active Control Admin, and `unparseable` is the host's label for a
// failure line it cannot classify. Nothing else may leave this file.
export const IDENTITY_ERROR_CODES = Object.freeze([
  'adapter_missing',
  'binding_env_mismatch',
  'cleanup_outcome_invalid',
  'connection_evidence_duplicate',
  'connection_evidence_invalid',
  'connection_prerequisite_missing',
  'connection_unrecorded',
  'control_admin_missing',
  'db_error',
  'identity_email_changed',
  'identity_ownership_changed',
  'intent_not_fresh',
  'invalid_provider',
  'invalid_run',
  'invitations_unexpected',
  'journal_binding_mismatch',
  'journal_fields_invalid',
  'journal_grant_mismatch',
  'journal_status_invalid',
  'membership_changed',
  'operator_link_history',
  'password_hash_invalid',
  'password_invalid',
  'profile_ownership_changed',
  'revocation_identity_mismatch',
  'scenario_ownership_changed',
  'scenario_set_invalid',
  'step_failed',
  'suite_invalid',
  'team_delete_mismatch',
  'team_grants_unrelated',
  'unparseable',
  'user_delete_mismatch',
  'user_grants_changed',
  'workflow_grants_changed',
])

// Closed set of phases. `validate-intent` covers the pre-transaction input,
// journal and adapter checks; `commit` wraps the transaction boundary and is
// entered only once its callback has returned; `publish-allowlist` wraps the
// post-commit publication; `unknown` labels an error the operation could not
// classify, so every reported failure still carries one of these phases.
export const IDENTITY_ERROR_PHASES = Object.freeze([
  'validate-intent',
  'lock-identities',
  'check-profiles',
  'check-memberships',
  'check-user-grants',
  'check-workflow-grants',
  'check-team-grants',
  'check-operator-links',
  'check-invitations',
  'revoke-connections',
  'rebuild-allowlist',
  'disable-approval-media',
  'append-permissions',
  'delete-users',
  'delete-team',
  'commit',
  'publish-allowlist',
  'unknown',
])

/**
 * The only failure shape an identity operation may report. Message, detail and
 * constraint text from a database error never reach this object; a caller may
 * read `code`, `phase` and `sqlstate` and nothing else.
 */
export class FixtureIdentityError extends Error {
  constructor(code, phase, sqlstate, message) {
    super(message)
    if (
      !IDENTITY_ERROR_CODES.includes(code) ||
      !IDENTITY_ERROR_PHASES.includes(phase) ||
      !(sqlstatePattern.test(sqlstate) || sqlstate === unclassifiedSqlstate)
    )
      throw new Error('Invalid fixture identity error')
    this.name = 'FixtureIdentityError'
    this.code = code
    this.phase = phase
    this.sqlstate = sqlstate
  }
}

// A refusal site names its own code; the enclosing step supplies the phase.
class IdentityRefusal extends Error {
  constructor(message, identityCode) {
    super(message)
    this.identityCode = identityCode
  }
}

function requireValue(condition, message, code) {
  if (condition) return
  if (!IDENTITY_ERROR_CODES.includes(code)) throw new Error('Invalid identity refusal code')
  throw new IdentityRefusal(message, code)
}

function asIdentityError(phase, error) {
  if (error instanceof FixtureIdentityError) return error
  if (error instanceof IdentityRefusal)
    return new FixtureIdentityError(error.identityCode, phase, unclassifiedSqlstate, error.message)
  const sqlstate = sqlstatePattern.test(error?.code ?? '') ? error.code : unclassifiedSqlstate
  return new FixtureIdentityError(
    sqlstate === unclassifiedSqlstate ? 'step_failed' : 'db_error',
    phase,
    sqlstate,
    'Fixture identity operation failed'
  )
}

// One step per statement group. `guard` is the synchronous form used before the
// transaction; `step` the asynchronous form; `commit` labels a failure at the
// transaction boundary only when the callback already returned.
function createSteps() {
  const current = { phase: 'validate-intent' }
  const enter = phase => {
    if (!IDENTITY_ERROR_PHASES.includes(phase)) throw new Error('Invalid identity phase')
    current.phase = phase
  }
  const guard = (phase, fn) => {
    enter(phase)
    try {
      return fn()
    } catch (error) {
      throw asIdentityError(phase, error)
    }
  }
  const step = async (phase, fn) => {
    enter(phase)
    try {
      return await fn()
    } catch (error) {
      throw asIdentityError(phase, error)
    }
  }
  const commit = async fn => {
    try {
      return await fn(() => enter('commit'))
    } catch (error) {
      if (error instanceof FixtureIdentityError) throw error
      throw asIdentityError(current.phase, error)
    }
  }
  return { guard, step, commit, phase: () => current.phase }
}

/**
 * The only payload the seed may print for a failed identity operation. Every
 * error yields the triple the host parser accepts: a FixtureIdentityError keeps
 * its own code, phase and SQLSTATE, and anything else is classified as an
 * unexpected step or database failure in the `unknown` phase. `unparseable`
 * therefore stays the host's label for a run that printed no valid line at all
 * (a crash, a lost process or a reporter that never ran).
 */
export function describeIdentityFailure(error) {
  const failure = asIdentityError('unknown', error)
  return { code: failure.code, phase: failure.phase, sqlstate: failure.sqlstate }
}

function binding(input, env) {
  requireValue(
    input.provider === undefined || ['codex', 'grok'].includes(input.provider),
    'Invalid fixture provider',
    'invalid_provider'
  )
  requireValue(
    /^approved-tools-[a-f0-9]{12}$/.test(input?.run ?? ''),
    'Invalid fixture run',
    'invalid_run'
  )
  requireValue(
    input.mode === 'deterministic' &&
      env.NODE_ENV === 'test' &&
      env.EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE === '1' &&
      env.APPROVED_TOOLS_RUN_ID === input.run &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.profile ?? '') &&
      input.context === input.profile &&
      env.MINIKUBE_PROFILE === input.profile &&
      env.CONTROL_API_REAL_PG_CONTEXT === input.context,
    'Fixture environment binding mismatch',
    'binding_env_mismatch'
  )
  return {
    mode: input.mode,
    run: input.run,
    profile: input.profile,
    context: input.context,
    ...(input.provider === 'grok' ? { provider: 'grok' } : {}),
  }
}

function identities(run) {
  return [run, `${run}-unauthorized`].map(name => ({ name, email: `${name}@example.test` }))
}

// `suite` is an identity *input* field only. It selects the scenario set; the
// journal is bound to that set by its grants, so no journal field changes.
const legacyApprovedToolsLabels = ['83', '150', '250', 'workflow']

/**
 * The scenario layout one suite run owns. A journal prepared before #1048 has no
 * `suite` field; prepare's legacy restore path passes it as `approved-tools`, and
 * that historical layout is the only one carrying the fourth (workflow) row. It
 * is accepted as such, and only when all four rows are present, so a live base
 * run can never keep a workflow grant.
 */
function suiteShape(suite, scenarios) {
  if (!Object.hasOwn(suiteLabels, suite ?? '')) return null
  const live = suiteLabels[suite]
  const labelsForSuite =
    suite === 'approved-tools' &&
    Array.isArray(scenarios) &&
    scenarios.length === legacyApprovedToolsLabels.length
      ? legacyApprovedToolsLabels
      : live
  return { labels: labelsForSuite, workflow: labelsForSuite.includes('workflow') }
}

function scenarioGrants(input) {
  const shape = suiteShape(input.suite, input.scenarios)
  requireValue(shape, 'Invalid fixture suite', 'suite_invalid')
  const expectedLabels = shape.labels
  requireValue(
    Array.isArray(input.scenarios) && input.scenarios.length === expectedLabels.length,
    expectedLabels.length === 1
      ? `Expected one ${input.suite} scenario`
      : `Expected ${expectedLabels.length} ${input.suite} scenarios`,
    'scenario_set_invalid'
  )
  const expected = expectedLabels.map(label => ({
    runId: `${input.run}-${label}`,
    agentName: `${input.run}-agent-${label}`,
    contextName: `${input.run}-context-${label}`,
  }))
  for (const [index, value] of expected.entries()) {
    requireValue(
      Object.entries(value).every(([key, item]) => input.scenarios[index]?.[key] === item),
      'Scenario ownership mismatch',
      'scenario_ownership_changed'
    )
  }
  return {
    agents: expected.map(value => value.agentName),
    contexts: expected.map(value => value.contextName),
    ...(shape.workflow
      ? { workflow: { namespace: 'sandbox-recipes', name: `${input.run}-recipe` } }
      : {}),
  }
}

function validateJournal(journal, input, env) {
  const scope = binding(input, env)
  requireValue(
    journal &&
      Object.keys(journal).every(key =>
        [
          'version',
          'provider',
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
    'Unexpected identity journal fields',
    'journal_fields_invalid'
  )
  requireValue(
    journal?.version === 1 && Object.entries(scope).every(([key, value]) => journal[key] === value),
    'Identity journal binding mismatch',
    'journal_binding_mismatch'
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
    'Invalid recorded identity ownership',
    'identity_ownership_changed'
  )
  const grants = scenarioGrants(input)
  requireValue(
    JSON.stringify(journal.grants) === JSON.stringify(grants),
    'Journal grant mismatch',
    'journal_grant_mismatch'
  )
  validateConnectionEvidence(journal, input)
  requireValue(
    input.provider !== 'grok' || journal.connections.length === 0,
    'Grok connection is user-owned',
    'connection_evidence_invalid'
  )
  requireValue(
    ['creation-pending', 'created', 'recovery-required', 'cleanup-pending', 'cleaned'].includes(
      journal.status
    ),
    'Invalid identity journal status',
    'journal_status_invalid'
  )
  requireValue(
    journal.cleanupOutcome === undefined ||
      ['recorded-identities-absent', 'deleted-with-audit-retained'].includes(
        journal.cleanupOutcome
      ),
    'Invalid cleanup outcome',
    'cleanup_outcome_invalid'
  )
  return grants
}

async function persist(save, journal) {
  // Pass a detached snapshot: adapters cannot accidentally persist later mutations.
  await save(structuredClone(journal))
}

// Allocate public fixture identity metadata on the host before remote mutation.
export function createFixtureIdentityJournal(input, { env }) {
  const steps = createSteps()
  const scope = steps.guard('validate-intent', () => binding(input, env))
  return {
    version: 1,
    ...scope,
    status: 'creation-pending',
    users: identities(input.run).map(user => ({ ...user, id: randomUUID() })),
    team: { id: randomUUID(), name: `${input.run}-team` },
    grants: steps.guard('validate-intent', () => scenarioGrants(input)),
    connections: [],
  }
}

function validateConnectionEvidence(journal, input) {
  const single = suiteIsSingle(input.suite)
  const allowedScenarios = suiteShape(input.suite, input.scenarios)?.labels ?? []
  requireValue(
    Array.isArray(journal.connections) &&
      journal.connections.length <= (single ? 1 : allowedScenarios.length),
    'Connection journal is required',
    'connection_evidence_invalid'
  )
  const fields = ['scenario', 'fixtureUserId', 'id', 'connectionKey', 'displayName', 'createdBy']
  for (const connection of journal.connections) {
    requireValue(
      connection &&
        Object.keys(connection).length === fields.length &&
        Object.keys(connection).every(key => fields.includes(key)) &&
        allowedScenarios.includes(connection.scenario) &&
        uuid.test(connection.id ?? '') &&
        /^codex-[a-f0-9]{16}$/.test(connection.connectionKey ?? '') &&
        connection.displayName === `Codex fixture ${connection.scenario} ${journal.run}` &&
        connection.fixtureUserId === journal.users[0].id &&
        connection.createdBy === null,
      'Invalid public connection creation evidence',
      'connection_evidence_invalid'
    )
  }
  for (const field of ['scenario', 'id', 'connectionKey'])
    requireValue(
      new Set(journal.connections.map(value => value[field])).size === journal.connections.length,
      'Duplicate connection creation evidence',
      'connection_evidence_duplicate'
    )
}

/** Called on the host with safe fields from the successful visible POST response.
 * fixtureUserId associates the experiment; it does not claim that Desktop user
 * created the connection. The real admin creation route stores created_by=NULL.
 * Persist immediately. A lost POST response is not recoverable by name adoption.
 */
export function recordFixtureConnection(input, journal, { env }, evidence) {
  const steps = createSteps()
  steps.guard('validate-intent', () => {
    validateJournal(journal, input, env)
    requireValue(
      journal.status === 'created',
      'Identity creation must finish before UI grant creation',
      'connection_prerequisite_missing'
    )
  })
  const proposed = structuredClone(journal)
  proposed.connections.push(structuredClone(evidence))
  steps.guard('validate-intent', () => validateConnectionEvidence(proposed, input))
  journal.connections = proposed.connections
  return journal
}

async function revokeRecordedConnections(db, journal, revoke, rebuild, steps) {
  // The Grok connection was created by the user and is never cleanup authority.
  if (journal.provider === 'grok') {
    requireValue(
      journal.connections.length === 0,
      'Grok connection is user-owned',
      'connection_evidence_invalid'
    )
    return
  }
  const expectedNames = labels.map(label => `Codex fixture ${label} ${journal.run}`)
  const rows = await steps.step('revoke-connections', async () => {
    // This bounded name query detects unjournaled POST outcomes only. Names never
    // supply deletion/revocation authority; every returned row needs recorded ID.
    const observed = (
      await db.query(
        `SELECT id::text, connection_key, display_name, created_by, status, revoked_at
    FROM codex_subscription_connections WHERE connection_key = ANY($1::text[])
      OR display_name = ANY($2::text[]) ORDER BY id FOR UPDATE`,
        [journal.connections.map(value => value.connectionKey), expectedNames]
      )
    ).rows
    requireValue(
      observed.length === journal.connections.length &&
        observed.every(row =>
          journal.connections.some(
            expected =>
              expected.id === row.id &&
              expected.connectionKey === row.connection_key &&
              expected.displayName === row.display_name &&
              expected.createdBy === row.created_by
          )
        ),
      'Unrecorded or changed connection; retain identities for recovery',
      'connection_unrecorded'
    )
    requireValue(
      !observed.length || (typeof revoke === 'function' && typeof rebuild === 'function'),
      'Normal connection revocation and catalog adapters are required',
      'adapter_missing'
    )
    for (const row of observed) {
      if (row.revoked_at !== null) {
        requireValue(
          row.status === 'revoked',
          'Invalid retained connection state',
          'revocation_identity_mismatch'
        )
        continue
      }
      const result = await revoke(db, row.connection_key)
      requireValue(
        result?.id === row.id &&
          result.connectionKey === row.connection_key &&
          result.status === 'revoked' &&
          result.revokedAt instanceof Date &&
          Number.isFinite(result.revokedAt.getTime()),
        'Connection revocation identity mismatch',
        'revocation_identity_mismatch'
      )
    }
    return observed
  })
  if (!rows.length) return
  await steps.step('rebuild-allowlist', () => rebuild(db))
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
  const steps = createSteps()
  const { grants, users } = steps.guard('validate-intent', () => {
    binding(input, env)
    const grants = scenarioGrants(input)
    return { grants, users: identities(input.run) }
  })
  const journal = structuredClone(initialJournal)
  steps.guard('validate-intent', () => {
    validateJournal(journal, input, env)
    requireValue(
      journal.status === 'creation-pending' &&
        journal.connections.length === 0 &&
        journal.cleanupOutcome === undefined,
      'Expected a fresh identity intent',
      'intent_not_fresh'
    )
    requireValue(
      input.userEmail === users[0].email && input.unauthorizedEmail === users[1].email,
      'Expected exact run-bound synthetic emails',
      'identity_email_changed'
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
      'Invalid fixture password',
      'password_invalid'
    )
    requireValue(
      typeof appendPermissionEvents === 'function' && typeof saveJournal === 'function',
      'Audit and durable journal adapters are required',
      'adapter_missing'
    )
  })
  const passwords = [input.userPassword, input.unauthorizedPassword]
  const hashes = await Promise.all(passwords.map(value => hashPassword(value, 12)))
  steps.guard('validate-intent', () =>
    requireValue(
      hashes.every(
        value => typeof value === 'string' && /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(value)
      ),
      'Expected installed bcrypt password hashes',
      'password_hash_invalid'
    )
  )
  await steps.step('validate-intent', () => persist(saveJournal, journal))
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
      if (grants.workflow)
        await db.query(
          `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
        VALUES ($1::uuid, $2, $3)`,
          [userId, grants.workflow.namespace, grants.workflow.name]
        )
      await appendFixturePermissions(
        db,
        journal,
        'grant',
        appendPermissionEvents,
        Boolean(grants.workflow)
      )
    })
    journal.status = 'created'
    await persist(saveJournal, journal)
    return journal
  } catch {
    // A failed COMMIT acknowledgement is ambiguous. Recorded random IDs permit
    // recovery without inferring ownership from a later same-email lookup.
    journal.status = 'recovery-required'
    await persist(saveJournal, journal)
    throw new Error('Fixture creation failed; recover using the recorded identity journal')
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

// Statement groups of the cleanup transaction. Each group is one closed phase;
// a refusal or database error inside it carries only that phase and its code.
// The retirement reason and key prefix are fixed so a retried cleanup replays
// the recorded operation instead of creating a second one.
const retirementReason = 'Approved tools E2E fixture identity cleanup'
const retirementKeyPrefix = 'approved-tools-cleanup:'

// Resolve the retirement actor from the lane's sign-in identifier, inside the
// cleanup transaction. The recorded operation then names a real Control Admin
// instead of a fabricated UUID; an identifier that does not resolve to exactly
// one active admin is a named refusal, never an actorless write.
//
// Same identifier semantics as the Control UI login (`findAdminByLogin` in
// control-api/src/services/adminAuthService.ts): the lane's TEST_ADMIN_USERNAME
// is a sign-in identifier, a username or an email. The predicate is mirrored
// here, not called, so it runs on the cleanup transaction's handle and a
// two-row match stays visible instead of being hidden by a `LIMIT 1`.
async function resolveRetirementActor(db, input) {
  const login = String(input.adminUsername ?? '').trim()
  const admins = (
    await db.query(
      `SELECT id::text, status FROM control_admin_users
        WHERE username = $1 OR lower(email) = lower($1)`,
      [login]
    )
  ).rows
  requireValue(
    login !== '' && admins.length === 1 && admins[0].status === 'active',
    "The lane's Control Admin does not resolve to exactly one active admin",
    'control_admin_missing'
  )
  return { kind: 'control_admin', controlAdminId: admins[0].id }
}

async function performCleanupTransaction(db, journal, grants, input, adapters, steps) {
  const ids = journal.users.map(user => user.id)
  const ownership = await steps.step('lock-identities', async () => {
    await db.query("SET LOCAL statement_timeout = '15s'")
    await db.query("SET LOCAL lock_timeout = '5s'")
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
    if (!users.length && !teams.length) return { absent: true }
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
      'Identity ownership changed',
      'identity_ownership_changed'
    )
    return { absent: false }
  })
  if (ownership.absent) {
    await revokeRecordedConnections(
      db,
      journal,
      adapters.revokeCodexSubscriptionConnection,
      adapters.rebuildLiveCodexUnionAllowlist,
      steps
    )
    return 'recorded-identities-absent'
  }
  await steps.step('check-profiles', async () => {
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
      'Profile ownership changed',
      'profile_ownership_changed'
    )
  })
  await steps.step('check-memberships', async () => {
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
      'Unrelated membership or changed role',
      'membership_changed'
    )
  })
  await steps.step('check-user-grants', async () => {
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
        'Unrelated or changed user grants',
        'user_grants_changed'
      )
    }
  })
  const workflowRows = await steps.step('check-workflow-grants', async () => {
    const rows = (
      await db.query(
        `SELECT user_id::text, recipe_namespace, recipe_name
        FROM user_workflow_triggers WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
        [ids]
      )
    ).rows
    requireValue(
      rows.length <= (grants.workflow ? 1 : 0) &&
        rows.every(
          row =>
            row.user_id === ids[0] &&
            row.recipe_namespace === grants.workflow?.namespace &&
            row.recipe_name === grants.workflow?.name
        ),
      'Unrelated or changed workflow grants',
      'workflow_grants_changed'
    )
    return rows
  })
  await steps.step('check-team-grants', async () => {
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
      requireValue(rows.length === 0, 'Unrelated team grants', 'team_grants_unrelated')
    }
  })
  await steps.step('check-operator-links', async () => {
    const links = (
      await db.query(
        'SELECT user_id FROM gfs_desktop_operator_links WHERE user_id = ANY($1::uuid[]) FOR UPDATE',
        [ids]
      )
    ).rows
    requireValue(
      links.length === 0,
      'Operator-link history requires governed retirement; identities retained',
      'operator_link_history'
    )
  })
  await steps.step('check-invitations', async () => {
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
      'Unexpected invitations; identities retained',
      'invitations_unexpected'
    )
  })
  await revokeRecordedConnections(
    db,
    journal,
    adapters.revokeCodexSubscriptionConnection,
    adapters.rebuildLiveCodexUnionAllowlist,
    steps
  )
  await steps.step('disable-approval-media', async () => {
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
  })
  await steps.step('append-permissions', () =>
    // WRC reconcileDelete may already have removed the exact recipe grant.
    // Only claim a workflow revocation when this transaction removes a row.
    appendFixturePermissions(
      db,
      journal,
      'revoke',
      adapters.appendPermissionEvents,
      workflowRows.length === 1
    )
  )
  await steps.step('delete-users', async () => {
    // A raw `DELETE FROM users` meets the password-admission fence (SQLSTATE
    // 55000) as soon as the user has identifier state, and it records no actor.
    // The product's governed retirement records a durable pending operation in
    // this same transaction, which is the only nested detach that fence admits.
    // Operator-link history was refused above, so the outcome must be `deleted`;
    // a tombstone would retain an identity this fixture must remove.
    const actor = await resolveRetirementActor(db, input)
    for (const user of journal.users) {
      const retired = await adapters.retireDesktopUserInTransaction(db, {
        actor,
        userId: user.id,
        reason: retirementReason,
        idempotencyKey: `${retirementKeyPrefix}${journal.run}:${user.id}`,
        requestId: null,
      })
      requireValue(
        retired?.outcome === 'deleted',
        'User deletion outcome mismatch',
        'user_delete_mismatch'
      )
    }
  })
  await steps.step('delete-team', async () => {
    const result = await db.query(
      'DELETE FROM teams WHERE id = $1::uuid AND name = $2 RETURNING id',
      [journal.team.id, journal.team.name]
    )
    requireValue(result.rowCount === 1, 'Team deletion ownership mismatch', 'team_delete_mismatch')
  })
  return 'deleted-with-audit-retained'
}

/**
 * Identities are removed only through the product's governed retirement path:
 * fresh active users with no operator-link history are physically deleted while
 * the durable retirement operation and any password-admission identifier state
 * are retained as audit. Retained-history cases fail closed, so no lifecycle
 * history is erased or fabricated here.
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
    retireDesktopUserInTransaction,
  }
) {
  const steps = createSteps()
  const grants = steps.guard('validate-intent', () => {
    const value = validateJournal(journal, input, env)
    requireValue(
      typeof appendPermissionEvents === 'function' &&
        typeof saveJournal === 'function' &&
        typeof publishRuntimeAllowlist === 'function' &&
        typeof retireDesktopUserInTransaction === 'function',
      'Audit, durable journal, runtime publication and governed retirement adapters are required',
      'adapter_missing'
    )
    return value
  })
  journal.status = 'cleanup-pending'
  await steps.step('validate-intent', () => persist(saveJournal, journal))
  try {
    const outcome = await steps.commit(async markReturned => {
      const value = await withTransaction(async db => {
        const result = await performCleanupTransaction(
          db,
          journal,
          grants,
          input,
          {
            appendPermissionEvents,
            revokeCodexSubscriptionConnection,
            rebuildLiveCodexUnionAllowlist,
            retireDesktopUserInTransaction,
          },
          steps
        )
        markReturned()
        return result
      })
      return value
    })
    // The ConfigMap writer reads committed state through its own DB client.
    // Never hold identity locks during K8s publication. Even the absent-ID retry
    // must republish: a preceding attempt may have committed then failed here.
    await steps.step('publish-allowlist', () => publishRuntimeAllowlist())
    journal.status = 'cleaned'
    journal.cleanupOutcome = outcome
    await persist(saveJournal, journal)
    return { outcome, auditRetention: 'preserved' }
  } catch (error) {
    journal.status = 'recovery-required'
    await persist(saveJournal, journal)
    throw error instanceof FixtureIdentityError ? error : asIdentityError(steps.phase(), error)
  }
}
