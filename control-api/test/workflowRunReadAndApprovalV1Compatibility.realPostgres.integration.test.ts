import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const OBSERVED_DEV_SOURCE_DIR = process.env.TASK106_R61_B1_DEV_SOURCE_DIR
const OBSERVED_DEV_SOURCE_COMMIT = '0b26101eb247adcc44f70d39451f3e82c3225d47'
const OBSERVED_DEV_DB_SOURCE_SHA256 =
  '1948ad306fe56b368f120edbc70ddbac6cb9b981d9fd218e7ded2575ed3b2beb'

if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  (!OBSERVED_DEV_SOURCE_DIR || !process.env.TASK106_R61_B1_LATEST_DEV_SOURCE_DIR)
) {
  throw new Error(
    'R61-B1 real PostgreSQL lane requires both pinned DEV producer source directories'
  )
}

const NS = 'sandbox-recipes'
const TEAM_ID = randomUUID()
const OWNER_ID = randomUUID()
const OTHER_USER_ID = randomUUID()
const database = `control_api_pr334_s2_${randomBytes(6).toString('hex')}`

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function privateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string
}

function verifyPinnedObservedProducer(): string {
  if (!OBSERVED_DEV_SOURCE_DIR)
    throw new Error('Test did not receive observed DEV source directory')
  const sourceDir = resolve(OBSERVED_DEV_SOURCE_DIR)
  expect(
    execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  ).toBe(OBSERVED_DEV_SOURCE_COMMIT)
  expect(
    execFileSync('git', ['-C', sourceDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  ).toBe('')
  expect(sha256File(join(sourceDir, 'control-api/src/db.ts'))).toBe(OBSERVED_DEV_DB_SOURCE_SHA256)
  const runner = join(sourceDir, 'control-api/dist/migrate.js')
  expect(existsSync(runner), 'observed DEV migration runner build').toBe(true)
  return runner
}

async function runObservedProducer(runner: string, connectionString: string): Promise<void> {
  const runnerDir = resolve(runner, '..')
  const child = spawn(process.execPath, [runner], {
    cwd: runnerDir,
    env: {
      NODE_ENV: 'test',
      CONTROL_API_PG_CONNECTION_STRING: connectionString,
      CONTROL_API_RPC_JWT_PRIVATE_KEY: privateKey(),
      CONTROL_API_SESSION_JWT_PRIVATE_KEY: privateKey(),
      CONTROL_API_ADMIN_JWT_PRIVATE_KEY: privateKey(),
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  const collect = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'))
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 240_000)
    timeout.unref()
    child.once('error', error => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new Error(
          `observed DEV migration runner exited ${code ?? signal}\n${output
            .join('')
            .replaceAll(connectionString, '<isolated test database URL>')
            .slice(-8_000)}`
        )
      )
    })
  })
}

async function runObservedFixtureWriter(
  connectionString: string,
  recipesToWrite: RecipeFixture[]
): Promise<Record<string, string>> {
  const sourceDir = resolve(OBSERVED_DEV_SOURCE_DIR!)
  const script = `
    import { pathToFileURL } from 'node:url'

    const fixture = JSON.parse(process.env.PR334_S2_FIXTURE)
    const oldTriggerUrl = pathToFileURL(process.env.PR334_S2_OLD_TRIGGER)
    const oldDbUrl = pathToFileURL(process.env.PR334_S2_OLD_DB)
    const oldTrigger = await import(oldTriggerUrl)
    const oldDb = await import(oldDbUrl)
    const resources = new Map()
    for (const recipe of fixture.recipes) {
      resources.set(recipe.name, {
        metadata: { name: recipe.name, namespace: fixture.ns },
        spec: {
          workloads: [],
          triggers: {
            onDemand: {
              requiresApproval: recipe.requiresApproval,
              ...(recipe.requiresApproval ? { allowedActors: ['user'] } : {}),
            },
          },
        },
      })
    }
    const gateway = {
      async getResource(plural, name, namespace) {
        if (plural === 'workflowrecipes' && namespace === fixture.ns) {
          const resource = resources.get(name)
          if (resource) return resource
        }
        throw Object.assign(new Error(plural + '/' + name + ' not found'), { statusCode: 404 })
      },
    }
    function claims(userId, teamId) {
      return {
        userId,
        email: userId + '@example.invalid',
        teamId,
        role: 'member',
        authGeneration: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
    }
    async function trigger(recipeName, callerClaims, key) {
      return oldTrigger.triggerWorkflow({
        gateway,
        caller: { kind: 'user-session', claims: callerClaims },
        recipeNamespace: fixture.ns,
        recipeName,
        body: { inputs: { value: key } },
        idempotencyKey: key,
      })
    }
    async function run(recipeName, callerClaims, key) {
      const result = await trigger(recipeName, callerClaims, key)
      if (result.kind !== 'run') throw new Error('Expected old producer run for ' + key)
      return result.row.run_id
    }
    async function approval(recipeName, callerClaims, key) {
      const result = await trigger(recipeName, callerClaims, key)
      if (result.kind !== 'approval') throw new Error('Expected old producer approval for ' + key)
    }
    const owner = claims(fixture.ownerId, fixture.teamId)
    const other = claims(fixture.otherUserId, fixture.teamId)
    const teamless = claims(fixture.ownerId, null)
    const output = {
      ownerRunId: await run(fixture.recipes[0].name, owner, 'pr334-s2-owner-live'),
      otherRunId: await run(fixture.recipes[0].name, other, 'pr334-s2-other-live'),
      teamlessRunId: await run(fixture.recipes[1].name, teamless, 'pr334-s2-teamless-live'),
      archiveRunId: await run(fixture.recipes[2].name, owner, 'pr334-s2-owner-archive'),
    }
    await approval(fixture.recipes[3].name, owner, 'pr334-s2-v1-3')
    await approval(fixture.recipes[4].name, teamless, 'pr334-s2-v1-4')
    await approval(fixture.recipes[5].name, owner, 'pr334-s2-v1-5')
    await oldDb.pool.end()
    await oldDb.rateLimitPool.end()
    process.stdout.write(JSON.stringify(output))
  `
  const fixture = {
    ns: NS,
    ownerId: OWNER_ID,
    otherUserId: OTHER_USER_ID,
    teamId: TEAM_ID,
    recipes: recipesToWrite,
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: sourceDir,
    env: {
      NODE_ENV: 'test',
      CONTROL_API_PG_CONNECTION_STRING: connectionString,
      CONTROL_API_RPC_JWT_PRIVATE_KEY: privateKey(),
      CONTROL_API_SESSION_JWT_PRIVATE_KEY: privateKey(),
      CONTROL_API_ADMIN_JWT_PRIVATE_KEY: privateKey(),
      PR334_S2_FIXTURE: JSON.stringify(fixture),
      PR334_S2_OLD_TRIGGER: join(
        sourceDir,
        'control-api/dist/services/workflows/workflowTriggerService.js'
      ),
      PR334_S2_OLD_DB: join(sourceDir, 'control-api/dist/db.js'),
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', chunk => stdout.push(chunk))
  child.stderr?.on('data', chunk => stderr.push(chunk))
  const close = new Promise<[number | null, NodeJS.Signals | null]>(
    (resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('close', (code, signal) => resolvePromise([code, signal]))
    }
  )
  const [code, signal] = await close
  if (code !== 0) {
    throw new Error(
      `observed DEV fixture writer exited ${code ?? signal}\n${Buffer.concat(stderr)
        .toString('utf8')
        .replaceAll(connectionString, '<isolated test database URL>')
        .slice(-8_000)}`
    )
  }
  return JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, string>
}

type RecipeFixture = {
  name: string
  requiresApproval: boolean
}

function recipeResource(recipe: RecipeFixture): Record<string, unknown> {
  return {
    metadata: { name: recipe.name, namespace: NS },
    spec: {
      workloads: [],
      triggers: {
        onDemand: {
          requiresApproval: recipe.requiresApproval,
          ...(recipe.requiresApproval ? { allowedActors: ['user'] } : {}),
        },
      },
    },
  }
}

function makeGateway(recipes: RecipeFixture[]): Record<string, unknown> {
  const resources = new Map<string, Record<string, unknown>>()
  for (const recipe of recipes) {
    resources.set(`${NS}/${recipe.name}`, recipeResource(recipe))
    resources.set(
      `${NS}/${recipe.name}-child`,
      recipeResource({ ...recipe, name: `${recipe.name}-child`, requiresApproval: false })
    )
  }
  return {
    async getResource(plural: string, name: string, namespace: string) {
      if (plural === 'workflowrecipes' && namespace === NS) {
        const resource = resources.get(`${namespace}/${name}`)
        if (resource) return resource
      }
      throw Object.assign(new Error(`${plural}/${name} not found`), { statusCode: 404 })
    },
  }
}

type OldClaims = {
  userId: string
  email: string
  teamId: string | null
  role: 'member'
  authGeneration: number
  exp: number
}

function v1Claims(userId: string, teamId: string | null): OldClaims {
  return {
    userId,
    email: `${userId}@example.invalid`,
    teamId,
    role: 'member',
    authGeneration: 1,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  }
}

describeRealPostgres('PR334 S2 workflow run visibility and V1 approval replay', () => {
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING
  if (adminUrl) process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

  let adminPool: Pool
  let databasePool: Pool
  let db: typeof import('../src/db.js')
  let reader: typeof import('../src/services/workflows/workflowRunReadService.js')
  let trigger: typeof import('../src/services/workflows/workflowTriggerService.js')
  let approvalService: typeof import('../src/services/workflows/workflowTriggerApprovalService.js')
  let artifacts: typeof import('../src/services/workflows/workflowRunArtifactService.js')
  let archive: typeof import('../src/services/workflowRunsArchiveService.js')
  let gateway: Record<string, unknown>
  let recipes: RecipeFixture[]
  let ownerRunId: string
  let otherRunId: string
  let teamlessRunId: string
  let archiveRunId: string

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })

    const runner = verifyPinnedObservedProducer()
    await runObservedProducer(runner, connectionString)

    recipes = [
      { name: `s2-visibility-${randomUUID()}`, requiresApproval: false },
      { name: `s2-teamless-${randomUUID()}`, requiresApproval: false },
      { name: `s2-archive-${randomUUID()}`, requiresApproval: false },
      { name: `s2-v1-team-${randomUUID()}`, requiresApproval: true },
      { name: `s2-v1-teamless-${randomUUID()}`, requiresApproval: true },
      { name: `s2-v1-removed-membership-${randomUUID()}`, requiresApproval: true },
      { name: `s2-v2-${randomUUID()}`, requiresApproval: true },
    ]
    gateway = makeGateway(recipes)

    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES
        ($1, 'pr334-s2-owner@example.invalid', 'PR334 S2 Owner'),
        ($2, 'pr334-s2-other@example.invalid', 'PR334 S2 Other')`,
      [OWNER_ID, OTHER_USER_ID]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'PR334 S2 Team')`, [TEAM_ID])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status) VALUES
        ($1, $2, 'member', 'active'),
        ($1, $3, 'member', 'active')`,
      [TEAM_ID, OWNER_ID, OTHER_USER_ID]
    )
    for (const recipe of recipes) {
      await databasePool.query(
        `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3), ($4, $2, $3)`,
        [OWNER_ID, NS, recipe.name, OTHER_USER_ID]
      )
    }

    const fixture = await runObservedFixtureWriter(connectionString, recipes)
    ownerRunId = fixture.ownerRunId!
    otherRunId = fixture.otherRunId!
    teamlessRunId = fixture.teamlessRunId!
    archiveRunId = fixture.archiveRunId!
    await databasePool.query(
      `UPDATE team_members SET status = 'deleted'
        WHERE team_id = $1 AND user_id = $2`,
      [TEAM_ID, OWNER_ID]
    )

    db = await import('../src/db.js')
    await db.initDb({ connect: () => databasePool.connect() })
    reader = await import('../src/services/workflows/workflowRunReadService.js')
    trigger = await import('../src/services/workflows/workflowTriggerService.js')
    approvalService = await import('../src/services/workflows/workflowTriggerApprovalService.js')
    artifacts = await import('../src/services/workflows/workflowRunArtifactService.js')
    archive = await import('../src/services/workflowRunsArchiveService.js')

    await databasePool.query(
      `UPDATE workflow_runs
          SET child_recipe_name = recipe_name || '-child',
              child_recipe_namespace = recipe_namespace
        WHERE run_id IN ($1::uuid, $2::uuid)`,
      [ownerRunId, otherRunId]
    )
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      await endPoolAndWaitForClients(db?.pool)
      await endPoolAndWaitForClients(db?.rateLimitPool)
      if (previousPgConnectionString === undefined) {
        delete process.env.CONTROL_API_PG_CONNECTION_STRING
      } else {
        process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgConnectionString
      }
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('shows an author an old team-attributed run without a live team grant, but not another author run', async () => {
    const teamGrants = await databasePool.query(
      'SELECT count(*)::int AS count FROM team_workflow_triggers'
    )
    expect(teamGrants.rows[0]).toEqual({ count: 0 })

    const ownerRow = (
      await databasePool.query('SELECT * FROM workflow_runs WHERE run_id = $1', [ownerRunId])
    ).rows[0]
    const otherRow = (
      await databasePool.query('SELECT * FROM workflow_runs WHERE run_id = $1', [otherRunId])
    ).rows[0]
    const caller = {
      kind: 'user-session' as const,
      claims: v1Claims(OWNER_ID, TEAM_ID),
      session: {} as never,
    }

    await expect(reader.canCallerReadWorkflowRun(caller, ownerRow)).resolves.toBe(true)
    await expect(reader.canCallerReadWorkflowRunWithApprovalTarget(caller, ownerRow)).resolves.toBe(
      true
    )
    await expect(reader.canCallerReadWorkflowRun(caller, otherRow)).resolves.toBe(false)
    await expect(reader.canCallerReadWorkflowRunWithApprovalTarget(caller, otherRow)).resolves.toBe(
      false
    )

    const visibilityRuns = await reader.listCanonicalRuns(NS, recipes[0]!.name, 10, caller)
    expect(visibilityRuns.map(run => run.id)).toEqual([ownerRunId])
    expect((await reader.getLatestRun(NS, recipes[0]!.name, caller))?.id).toBe(ownerRunId)
    expect((await reader.getWorkflowHealth(NS, recipes[0]!.name, caller)).lastRun?.id).toBe(
      ownerRunId
    )

    const teamlessRuns = await reader.listCanonicalRuns(NS, recipes[1]!.name, 10, caller)
    expect(teamlessRuns.map(run => run.id)).toEqual([teamlessRunId])

    const artifactContext = await artifacts.resolveWorkflowArtifactContext({
      gateway: gateway as never,
      caller,
      recipeNamespace: NS,
      recipeName: recipes[0]!.name,
      runId: ownerRunId,
    })
    expect(artifactContext.run.run_id).toBe(ownerRunId)
    await expect(
      artifacts.resolveWorkflowArtifactContext({
        gateway: gateway as never,
        caller,
        recipeNamespace: NS,
        recipeName: recipes[0]!.name,
        runId: otherRunId,
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('shows the author an archived own run through the audit reader', async () => {
    await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'Succeeded',
              started_at = NOW() - interval '2 seconds',
              completed_at = NOW() - interval '1 second',
              ttl_seconds_after_finished = 0
        WHERE run_id = $1`,
      [archiveRunId]
    )
    const archived = await archive.archiveTerminalRuns(gateway as never, {
      graceMs: 1,
      batchSize: 10,
      maxBatches: 1,
    })
    expect(archived).toBe(1)
    const live = await databasePool.query(
      'SELECT count(*)::int AS count FROM workflow_runs WHERE run_id = $1',
      [archiveRunId]
    )
    const audit = await databasePool.query(
      'SELECT count(*)::int AS count FROM workflow_runs_audit WHERE run_id = $1',
      [archiveRunId]
    )
    expect(live.rows[0]).toEqual({ count: 0 })
    expect(audit.rows[0]).toEqual({ count: 1 })

    const caller = {
      kind: 'user-session' as const,
      claims: v1Claims(OWNER_ID, TEAM_ID),
      session: {} as never,
    }
    const runs = await reader.listCanonicalRuns(NS, recipes[2]!.name, 10, caller)
    expect(runs.map(run => run.id)).toEqual([archiveRunId])
    expect(runs[0]?.source).toBe('audit')
    expect((await reader.getLatestRun(NS, recipes[2]!.name, caller))?.id).toBe(archiveRunId)
    expect((await reader.getWorkflowHealth(NS, recipes[2]!.name, caller)).lastRun?.id).toBe(
      archiveRunId
    )
  })

  it.each([
    {
      label: 'active team membership',
      recipeIndex: 3,
      claims: () => v1Claims(OWNER_ID, TEAM_ID),
      expectedKey: `external-rest-api:user:${OWNER_ID}:team:${TEAM_ID}`,
      membershipStatus: 'active',
    },
    {
      label: 'teamless V1 session',
      recipeIndex: 4,
      claims: () => v1Claims(OWNER_ID, null),
      expectedKey: `external-rest-api:user:${OWNER_ID}:team:null`,
      membershipStatus: null,
    },
    {
      label: 'removed team membership',
      recipeIndex: 5,
      claims: () => v1Claims(OWNER_ID, TEAM_ID),
      expectedKey: `external-rest-api:user:${OWNER_ID}:team:${TEAM_ID}`,
      membershipStatus: 'deleted',
    },
  ])('replays a base-produced V1 approval with the base caller key ($label)', async scenario => {
    const recipe = recipes[scenario.recipeIndex]!
    const key = `pr334-s2-v1-${scenario.recipeIndex}`
    const persistedKey = (
      await databasePool.query(
        `SELECT wati.trigger_caller_key
           FROM workflow_approval_trigger_intents wati
           JOIN workflow_approval_requests war ON war.id = wati.approval_request_id
          WHERE war.recipe_namespace = $1 AND war.recipe_name = $2 AND war.idempotency_key = $3`,
        [NS, recipe.name, key]
      )
    ).rows[0]?.trigger_caller_key
    expect(persistedKey).toBe(scenario.expectedKey)
    if (scenario.membershipStatus) {
      await databasePool.query(
        `UPDATE team_members SET status = $3
          WHERE team_id = $1 AND user_id = $2`,
        [TEAM_ID, OWNER_ID, scenario.membershipStatus]
      )
      const member = await databasePool.query(
        'SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2',
        [TEAM_ID, OWNER_ID]
      )
      expect(member.rows[0]).toEqual({ status: scenario.membershipStatus })
    }

    const replay = await trigger.triggerWorkflow({
      gateway: gateway as never,
      caller: {
        kind: 'user-session',
        claims: scenario.claims(),
        session: {} as never,
      },
      recipeNamespace: NS,
      recipeName: recipe.name,
      body: { inputs: { value: key } },
      idempotencyKey: key,
    })
    expect(replay).toMatchObject({
      kind: 'approval',
      approvalRequestId: expect.any(String),
      existing: true,
    })

    const mismatch = await approvalService.createWorkflowTriggerApprovalRequest({
      recipeNamespace: NS,
      recipeName: recipe.name,
      callerKey: scenario.expectedKey,
      targetUserId: OWNER_ID,
      payload: {
        message: 'Changed PR334 S2 replay payload',
        metadata: {
          workflowTrigger: {
            namespace: NS,
            name: recipe.name,
            caller: scenario.expectedKey,
          },
        },
      },
      idempotencyKey: key,
      correlation: { taskId: key },
      runIntent: {
        actorType: 'user',
        actorId: OWNER_ID,
        teamId: scenario.claims().teamId,
        usageTeamId: scenario.claims().teamId,
        triggerSource: 'onDemand',
        inputs: {},
        intermediateParameters: null,
        outputOverrides: null,
        maxDurationSeconds: null,
        ttlSecondsAfterFinished: null,
      },
    })
    expect(mismatch).toMatchObject({
      kind: 'mismatch',
      reason: 'payload_hash_mismatch',
    })
  })

  it('keeps the direct caller key for V2 user sessions', async () => {
    const recipe = recipes[6]!
    const key = 'pr334-s2-v2'
    const claims = {
      ...v1Claims(OWNER_ID, null),
      sessionContract: 'v2' as const,
    }
    const created = await trigger.triggerWorkflow({
      gateway: gateway as never,
      caller: { kind: 'user-session', claims, session: {} as never },
      recipeNamespace: NS,
      recipeName: recipe.name,
      body: { inputs: { value: key } },
      idempotencyKey: key,
    })
    expect(created.kind).toBe('approval')
    const persistedKey = (
      await databasePool.query(
        `SELECT wati.trigger_caller_key
           FROM workflow_approval_trigger_intents wati
           JOIN workflow_approval_requests war ON war.id = wati.approval_request_id
          WHERE war.recipe_namespace = $1 AND war.recipe_name = $2 AND war.idempotency_key = $3`,
        [NS, recipe.name, key]
      )
    ).rows[0]?.trigger_caller_key
    expect(persistedKey).toBe(`external-rest-api:user:${OWNER_ID}:direct`)

    const replay = await trigger.triggerWorkflow({
      gateway: gateway as never,
      caller: { kind: 'user-session', claims, session: {} as never },
      recipeNamespace: NS,
      recipeName: recipe.name,
      body: { inputs: { value: key } },
      idempotencyKey: key,
    })
    expect(replay).toMatchObject({ kind: 'approval', existing: true })
  })
})
