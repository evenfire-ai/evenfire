import { afterAll, beforeAll, expect, describe as vitestDescribe } from 'vitest'
import { it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

/**
 * issue #375 (P3) — grant-update NOTIFY on real PostgreSQL.
 *
 * Verifies the property the WRC LISTEN side depends on: the grant-mutation
 * transactions emit a `pg_notify` on `plugin_workload_sdk_grant_update` that is
 * delivered on COMMIT and discarded on ROLLBACK.
 *
 * Real database, no mocks. The service module's module-level pool (src/db.ts) is
 * pointed at a throwaway database by setting CONTROL_API_PG_CONNECTION_STRING
 * BEFORE the dynamic src imports in beforeAll — nothing from src/ is value-
 * imported statically here, matching the other *.realPostgres suites.
 */

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
// Repo convention (matches the other *.realPostgres.integration.test.ts suites):
// gate on the DB env so the DB-less unit lane stays green; the Postgres-backed
// CI lane sets CONTROL_API_REAL_PG_ADMIN_URL and runs it non-skipped.
const describeRealPostgres = adminUrl ? vitestDescribe : vitestDescribe.skip

const database = `control_api_sdk_notify_${randomBytes(6).toString('hex')}`

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

const previousPgConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING
const throwawayUrl = adminUrl ? databaseUrl(adminUrl, database) : undefined
if (adminUrl && throwawayUrl) {
  process.env.CONTROL_API_PG_CONNECTION_STRING = throwawayUrl
}

const NS = 'sandbox-recipes'
const RECIPE = 'notify-recipe'
// upsertGrant records the acting operator as permission-event `operator_user_id`,
// a UUID column: a real DB rejects a non-UUID like 'operator-1' with 22P02
// (invalid input syntax for type uuid) — the failure the mocked DB-less lane
// never saw. Pass a real UUID. The write target here (administrative_events)
// has no FK, but sibling operator columns on other audit tables do reference
// users(id), so seed a real users row defensively and pass its id as operatorSub.
const OPERATOR_ID = randomUUID()

describeRealPostgres(
  'Plugin Workload SDK grant-update NOTIFY on real PostgreSQL (issue #375)',
  () => {
    let adminPool: Pool
    let db: typeof import('../src/db.js')
    let sdk: typeof import('../src/services/pluginWorkloadSdkDb.js')
    let listenPool: Pool
    let listenClient: PoolClient
    let received: Array<{ channel: string; payload?: string }>

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      db = await import('../src/db.js')
      await db.initDb()
      sdk = await import('../src/services/pluginWorkloadSdkDb.js')

      // Seed the acting operator (defensive: keeps any FK'd operator_user_id
      // column referencing users(id) satisfied on a real database).
      await db.pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
        OPERATOR_ID,
        `sdk-notify-operator-${OPERATOR_ID}@example.test`,
        'sdk-notify-operator',
      ])

      received = []
      listenPool = new Pool({ connectionString: throwawayUrl })
      listenClient = await listenPool.connect()
      listenClient.on('notification', msg => {
        received.push({ channel: msg.channel, payload: msg.payload })
      })
      await listenClient.query(`LISTEN ${sdk.PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL}`)
    })

    afterAll(async () => {
      try {
        await listenClient?.query(`UNLISTEN ${sdk.PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL}`)
      } catch {
        /* teardown */
      }
      listenClient?.release()
      await listenPool?.end()
      await db?.pool.end()
      if (previousPgConnectionString === undefined) {
        delete process.env.CONTROL_API_PG_CONNECTION_STRING
      } else {
        process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgConnectionString
      }
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
        await adminPool.end()
      }
    })

    /** Poll the LISTEN client until a notification arrives on our channel or timeout. */
    async function waitForGrantNotification(timeoutMs = 3_000): Promise<string | undefined> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        // Round-trip a trivial query so pg flushes any pending notifications.
        await listenClient.query('SELECT 1')
        const hit = received.find(m => m.channel === sdk.PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL)
        if (hit) return hit.payload
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return undefined
    }

    it('delivers the NOTIFY after upsertGrant COMMITs', async () => {
      received.length = 0
      await sdk.upsertGrant(
        {
          recipeNamespace: NS,
          recipeName: RECIPE,
          capabilityFamily: 'promptBridge',
          provider: 'openai',
          allowedModels: ['gpt-5'],
          allowedCallers: ['api'],
        },
        OPERATOR_ID
      )

      const payload = await waitForGrantNotification()
      expect(payload, 'expected a grant-update NOTIFY after commit').toBeDefined()
      expect(JSON.parse(String(payload))).toEqual({
        recipeNamespace: NS,
        recipeName: RECIPE,
        capabilityFamily: 'promptBridge',
      })
    })

    it('discards BOTH the mutation and the NOTIFY when a real mutation transaction ROLLBACKs', async () => {
      // This proves the grant-update NOTIFY is transactionally coupled to the grant
      // mutation (delivered on COMMIT, discarded on ROLLBACK).
      //
      // WHY not fail a real service call (upsert/delete/revoke) after its notify:
      // `notifyGrantUpdate` is the TERMINAL statement of each of those functions —
      // nothing in them can throw after it — so a "production mutation that fails
      // after the notify" cannot be constructed. Instead we reproduce the exact
      // production shape: a REAL mutation (UPDATE of the committed grant) plus the
      // REAL notify (same channel + payload builder) inside the production
      // `withTransaction` wrapper, then abort it — and assert BOTH are discarded.
      received.length = 0
      const before = await db.pool.query<{ default_target_ref: string | null }>(
        `SELECT default_target_ref FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND capability_family = 'promptBridge'`,
        [NS, RECIPE]
      )

      await expect(
        db.withTransaction(async client => {
          await client.query(
            `UPDATE plugin_workload_sdk_grants SET default_target_ref = 'ROLLED-BACK-SENTINEL'
            WHERE recipe_namespace = $1 AND recipe_name = $2 AND capability_family = 'promptBridge'`,
            [NS, RECIPE]
          )
          await client.query('SELECT pg_notify($1, $2)', [
            sdk.PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
            sdk.buildGrantUpdateNotifyPayload({ recipeNamespace: NS, recipeName: RECIPE }),
          ])
          throw new Error('force rollback')
        })
      ).rejects.toThrow('force rollback')

      // The NOTIFY was discarded on rollback...
      const delivered = await waitForGrantNotification(1_000)
      expect(delivered, 'a rolled-back NOTIFY must never be delivered').toBeUndefined()

      // ...and so was the mutation — the grant is unchanged, proving the notify
      // shared the mutation's transaction.
      const after = await db.pool.query<{ default_target_ref: string | null }>(
        `SELECT default_target_ref FROM plugin_workload_sdk_grants
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND capability_family = 'promptBridge'`,
        [NS, RECIPE]
      )
      expect(after.rows[0]?.default_target_ref).toBe(before.rows[0]?.default_target_ref)
      expect(after.rows[0]?.default_target_ref).not.toBe('ROLLED-BACK-SENTINEL')
    })
  }
)
