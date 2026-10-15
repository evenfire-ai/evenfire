import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { findActiveRunForRecipe } from '../src/services/workflowScheduleWorkerService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const NS = 'p3-forbid'
const OTHER_NS = 'p3-forbid-other'

type Fixture = {
  recipe: string
  namespace?: string
  phase: 'Pending' | 'Running' | 'Succeeded'
  /** Recipe whose run this row is (defaults to `recipe`). */
  runOf?: string
  /** Run-scoped child CR name; never the identity the lookup matches on. */
  childRecipeName?: string
  createdMinutesAgo: number
  startedMinutesAgo: number | null
  maxDurationSeconds: number | null
}

/**
 * One isolated recipe per case so the lookup's LIMIT 1 cannot hide a row.
 * `blocks` = the Forbid gate would skip the tick; otherwise it would fire.
 */
const cases: Array<{ name: string; blocks: boolean; fixture: Fixture }> = [
  {
    name: 'a Running run of the same recipe blocks',
    blocks: true,
    fixture: {
      recipe: 'running-same',
      phase: 'Running',
      childRecipeName: 'running-same-run-0001',
      createdMinutesAgo: 3,
      startedMinutesAgo: 2,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Succeeded run of the same recipe does not block',
    blocks: false,
    fixture: {
      recipe: 'succeeded-same',
      phase: 'Succeeded',
      createdMinutesAgo: 3,
      startedMinutesAgo: 2,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Running run of another recipe does not block, even when its child CR has our name',
    blocks: false,
    fixture: {
      recipe: 'other-recipe-target',
      runOf: 'some-other-recipe',
      phase: 'Running',
      childRecipeName: 'other-recipe-target',
      createdMinutesAgo: 3,
      startedMinutesAgo: 2,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Running run of the same name in another namespace does not block',
    blocks: false,
    fixture: {
      recipe: 'same-name-other-ns',
      namespace: OTHER_NS,
      phase: 'Running',
      createdMinutesAgo: 3,
      startedMinutesAgo: 2,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a fresh Pending run blocks',
    blocks: true,
    fixture: {
      recipe: 'pending-fresh',
      phase: 'Pending',
      createdMinutesAgo: 1,
      startedMinutesAgo: null,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Pending run older than the 15 min bound does not block',
    blocks: false,
    fixture: {
      recipe: 'pending-stale',
      phase: 'Pending',
      createdMinutesAgo: 16,
      startedMinutesAgo: null,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Running run inside max_duration_seconds + grace blocks',
    blocks: true,
    fixture: {
      recipe: 'running-within-grace',
      phase: 'Running',
      createdMinutesAgo: 13,
      startedMinutesAgo: 12,
      maxDurationSeconds: 600,
    },
  },
  {
    name: 'a Running run past max_duration_seconds + grace does not block',
    blocks: false,
    fixture: {
      recipe: 'running-stale',
      phase: 'Running',
      createdMinutesAgo: 17,
      startedMinutesAgo: 16,
      maxDurationSeconds: 600,
    },
  },
  {
    name: 'a Running run with NULL max_duration_seconds blocks inside the 24 h cap',
    blocks: true,
    fixture: {
      recipe: 'running-null-within-cap',
      phase: 'Running',
      createdMinutesAgo: 23 * 60 + 1,
      startedMinutesAgo: 23 * 60,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a Running run with NULL max_duration_seconds does not block past the cap + grace',
    blocks: false,
    fixture: {
      recipe: 'running-null-past-cap',
      phase: 'Running',
      createdMinutesAgo: 24 * 60 + 7,
      startedMinutesAgo: 24 * 60 + 6,
      maxDurationSeconds: null,
    },
  },
  {
    name: 'a max_duration_seconds above the cap is clamped to it',
    blocks: false,
    fixture: {
      recipe: 'running-oversized-max',
      phase: 'Running',
      createdMinutesAgo: 25 * 60 + 1,
      startedMinutesAgo: 25 * 60,
      maxDurationSeconds: 604_800,
    },
  },
  {
    name: 'a Running run with NULL started_at is aged from created_at',
    blocks: true,
    fixture: {
      recipe: 'running-null-started',
      phase: 'Running',
      createdMinutesAgo: 2,
      startedMinutesAgo: null,
      maxDurationSeconds: null,
    },
  },
]

describeRealPostgres('workflow schedule Forbid active-run lookup (real Postgres)', () => {
  const database = `wf_schedule_forbid_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  const runIds = new Map<string, string>()

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    // The real migrated schema, not a hand-written copy of workflow_runs.
    await initDb({ connect: () => pool.connect() })

    for (const { fixture } of cases) {
      const inserted = await pool.query<{ run_id: string }>(
        `INSERT INTO workflow_runs
           (recipe_namespace, recipe_name, phase, actor_type, trigger_source,
            child_recipe_name, max_duration_seconds, created_at, started_at)
         VALUES ($1, $2, $3, 'scheduled', 'schedule', $4, $5,
                 now() - make_interval(mins => $6),
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(mins => $7::int) END)
         RETURNING run_id`,
        [
          fixture.namespace ?? NS,
          fixture.runOf ?? fixture.recipe,
          fixture.phase,
          fixture.childRecipeName ?? null,
          fixture.maxDurationSeconds,
          fixture.createdMinutesAgo,
          fixture.startedMinutesAgo,
        ]
      )
      runIds.set(fixture.recipe, inserted.rows[0]!.run_id)
    }
  }, 180_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(pool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  })

  it.each(cases)('$name', async ({ blocks, fixture }) => {
    const client = await pool.connect()
    try {
      const active = await findActiveRunForRecipe(client, NS, fixture.recipe)
      if (blocks) {
        expect(active?.run_id).toBe(runIds.get(fixture.recipe))
        expect(active?.phase).toBe(fixture.phase)
      } else {
        expect(active).toBeNull()
      }
    } finally {
      client.release()
    }
  })
})
