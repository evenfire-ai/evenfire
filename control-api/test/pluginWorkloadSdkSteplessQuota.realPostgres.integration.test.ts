import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PluginWorkloadSdkFamily } from '../src/services/pluginWorkloadSdkDb.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

/**
 * Stepless / SDK-only quota regression on real PostgreSQL (issue #348,
 * plan D4) — THE ACCEPTANCE-DEFINING RED-FIRST TEST.
 *
 * Test 1 asserts the POST-change target behavior and MUST FAIL against
 * pre-change code (RED): today a stepless recipe (zero `workflow_runs` rows)
 * books every per-run quota unit under the immortal epoch-sentinel bucket
 * (`resolveQuotaPeriodStart` → `PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD =
 * new Date(0)`), so a per-run cap becomes a lifetime cap that nothing ever
 * resets. After Phase 1 the per-run leg is inert and every call is allowed.
 * Do NOT weaken these assertions to pass early.
 *
 * POST-PHASE-1 NOTE (applied, audit finding 1): Phase 1 DELETED `consumeQuota`
 * outright (plan decision §3.2 — delete, don't stub; the RED runs were
 * captured against the pre-change `consumeQuota` API before the deletion).
 * Tests 1 and 3 exercise the REAL enforcement entry points —
 * `authorizePromptBridge` and (mirror) `authorizeClientNotification` in
 * `src/services/pluginWorkloadSdkAuthorizer.ts` — against the real database.
 * Pointing them at `checkRateLimit` alone would be near-vacuous: that function
 * is the per-MINUTE gate and never consulted the per-RUN cap or
 * `plugin_workload_sdk_quota_counters` even pre-change, so a future re-wire of
 * the per-run leg inside the AUTHORIZER would not trip it. Going through the
 * authorizer means ANY quota consultation reachable from the authorization
 * pipeline (present or reintroduced) is under test. The assertions:
 *   (a) the authorizer never denies a stepless recipe past its declared
 *       per-run cap (the deprecated cap is inert), and
 *   (b) `plugin_workload_sdk_quota_counters` receives NO writes on that path
 *       (the epoch-sentinel bucket is never touched) — counted before/after.
 * Test 2 stays on `checkRateLimit` deliberately: the per-minute window/reset
 * semantics are exactly that function's contract.
 *
 * Real database, real `plugin_workload_sdk_quota_counters` and
 * `plugin_workload_sdk_invocations` tables — NO db mock. The service module's
 * pool (`src/db.ts` module-level `pool`, built from
 * `CONTROL_API_PG_CONNECTION_STRING` at import time) is pointed at a fresh
 * throwaway database by setting that env var BEFORE the src modules are
 * dynamically imported in beforeAll; nothing from `src/` is value-imported
 * statically in this file for exactly that reason.
 */

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
// Repo convention (matches the other *.realPostgres.integration.test.ts suites):
// gate on the DB env so the DB-less unit lane stays green. This suite is EXECUTED
// for real in the DB-provisioned lane (T2 / minikube: point
// CONTROL_API_REAL_PG_ADMIN_URL at the cluster Postgres). The T2 gate asserts this
// suite actually ran (total>0, not skipped) so it can never pass by silent
// omission (issue #348, plan D4; local run gated per owner decision).
const describeRealPostgres = adminUrl ? describe : describe.skip

const database = `control_api_sdk_stepless_${randomBytes(6).toString('hex')}`

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

// Redirect the module-level pool of src/db.ts to the throwaway database.
// This runs at import time, strictly before the dynamic src imports below.
// Guarded on adminUrl so the DB-less (skipped) lane never builds a URL from undefined.
const previousPgConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING
if (adminUrl) {
  process.env.CONTROL_API_PG_CONNECTION_STRING = databaseUrl(adminUrl, database)
}

const NS = 'sandbox-recipes'
const CALLER_REF = 'api'

/** Claims fixture mirrored from test/services.pluginWorkloadSdkAuthorizer.test.ts. */
function claimsFor(recipeName: string): McpHostAccessClaims {
  return {
    sub: `${NS}/${recipeName}`,
    recipeNamespace: NS,
    recipeName,
    hostRefs: [`${NS}/${recipeName}`],
    scope: 'workflow:approval:request',
    workflowControlScopes: ['plugin-workload-sdk'] as McpHostAccessClaims['workflowControlScopes'],
    iss: 'control-api',
    aud: 'workflow-approvals',
    jti: 'test-jti',
    exp: Math.floor(Date.now() / 1000) + 300,
  }
}

describeRealPostgres(
  'Plugin Workload SDK stepless quota enforcement on real PostgreSQL (issue #348)',
  () => {
    let adminPool: Pool
    let db: typeof import('../src/db.js')
    let quotaTracker: typeof import('../src/services/pluginWorkloadSdkQuotaTracker.js')
    let authorizer: typeof import('../src/services/pluginWorkloadSdkAuthorizer.js')

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      // Import AFTER the database exists and AFTER the env override above so
      // the module-level pool binds to the fresh database.
      db = await import('../src/db.js')
      await db.initDb()
      quotaTracker = await import('../src/services/pluginWorkloadSdkQuotaTracker.js')
      authorizer = await import('../src/services/pluginWorkloadSdkAuthorizer.js')
    })

    afterAll(async () => {
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
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
        await adminPool.end()
      }
    })

    /** Fail-loud stepless precondition: the recipe has ZERO workflow_runs rows. */
    async function assertStepless(recipeName: string): Promise<void> {
      const runs = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM workflow_runs
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, recipeName]
      )
      expect(runs.rows[0]?.n, `stepless precondition for ${recipeName}`).toBe(0)
    }

    /** Rows currently booked in the (deprecated) per-run counter bucket table. */
    async function quotaCounterRowCount(recipeName: string): Promise<number> {
      const result = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plugin_workload_sdk_quota_counters
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, recipeName]
      )
      return result.rows[0]?.n ?? 0
    }

    /**
     * Seed an operator-reviewed, ACTIVE promptBridge grant exactly as the
     * authorizer requires it (policy_revision >= 1, first ordered target ==
     * default_target_ref, durable review provenance). The INSERT mirrors the
     * grant seeding of pluginWorkloadSdkPolicyReview.realPostgres.integration
     * .test.ts, extended with quota_limits so the deprecated per-run cap is on
     * the row the authorizer actually loads via findGrant.
     */
    async function seedPromptBridgeGrant(
      recipeName: string,
      quotaLimits: Record<string, number>
    ): Promise<void> {
      await db.pool.query(
        `INSERT INTO plugin_workload_sdk_grants
         (recipe_namespace, recipe_name, capability_family, provider,
          allowed_callers, quota_limits, prompt_targets, default_target_ref,
          policy_revision, policy_state, policy_reviewed_at, policy_reviewed_by)
       VALUES ($1, $2, 'promptBridge', 'openai',
               '["${CALLER_REF}"]'::jsonb, $3::jsonb,
               '[{"targetRef":"primary","provider":"openai","model":"gpt-4o-mini","credentialSlot":"openai-api-key"}]'::jsonb,
               'primary', 1, 'active', now(), 'operator-1')`,
        [NS, recipeName, JSON.stringify(quotaLimits)]
      )
    }

    /**
     * Seed an ACTIVE clientNotifications grant plus the real recipient row the
     * authorizer's `hasUsableClientNotificationRecipients` check resolves
     * against (a `users` row with a non-empty email). Same INSERT mirror as the
     * promptBridge seeding above.
     */
    async function seedClientNotificationsGrant(
      recipeName: string,
      eventType: string,
      quotaLimits: Record<string, number>
    ): Promise<void> {
      const userId = randomUUID()
      await db.pool.query(`INSERT INTO users (id, email) VALUES ($1::uuid, $2)`, [
        userId,
        `sdk-stepless-${recipeName}@e2e.local`,
      ])
      await db.pool.query(
        `INSERT INTO plugin_workload_sdk_grants
         (recipe_namespace, recipe_name, capability_family,
          allowed_event_types, allowed_user_refs, allowed_callers, quota_limits,
          policy_revision, policy_state, policy_reviewed_at, policy_reviewed_by)
       VALUES ($1, $2, 'clientNotifications',
               $3::jsonb, $4::jsonb, '["${CALLER_REF}"]'::jsonb, $5::jsonb,
               1, 'active', now(), 'operator-1')`,
        [
          NS,
          recipeName,
          JSON.stringify([eventType]),
          JSON.stringify([userId]),
          JSON.stringify(quotaLimits),
        ]
      )
    }

    /**
     * Seed invocation-audit rows inside the trailing per-minute window
     * (created_at defaults to now()). contract_version 1 + status 'complete'
     * keeps the rows clear of the v2 lease constraint; the per-row idempotency
     * suffix satisfies the (namespace, name, method, hash) unique index.
     */
    async function seedInvocationWindowRows(
      recipeName: string,
      method: PluginWorkloadSdkFamily,
      detail: string,
      count: number
    ): Promise<void> {
      const result = await db.pool.query(
        `INSERT INTO plugin_workload_sdk_invocations
         (recipe_namespace, recipe_name, caller_ref, method, detail,
          idempotency_key_hash, payload_hash, status, authorization_decision,
          contract_version, attempt_generation)
       SELECT $1, $2, 'stepless-quota-integration', $3, $4,
              $2 || '-' || $3 || '-window-' || g::text, '', 'complete', 'authorized', 1, 1
         FROM generate_series(1, $5::int) AS g`,
        [NS, recipeName, method, detail, count]
      )
      if (result.rowCount !== count) {
        throw new Error(
          `window seed for ${recipeName}/${method} inserted ${result.rowCount} rows, expected ${count}`
        )
      }
    }

    it('never denies a stepless recipe on per-run caps through the AUTHORIZER and books nothing in quota counters (RED vs pre-change code)', async () => {
      const recipeName = `stepless-run-cap-${randomBytes(4).toString('hex')}`
      await assertStepless(recipeName)
      await seedPromptBridgeGrant(recipeName, { maxRequestsPerRun: 3 })
      const claims = claimsFor(recipeName)

      // The deprecated per-run bucket table starts empty for this recipe.
      expect(await quotaCounterRowCount(recipeName), 'counters before any call').toBe(0)

      // FOUR full authorization passes — one PAST the declared per-run cap of 3
      // — through the real enforcement entry point (grant lookup, audit-record
      // reservation, rate check; each with a fresh idempotency key so no replay
      // short-circuit hides the quota path). TARGET behavior: the deprecated
      // per-run cap is inert, so every call is authorized. Pre-change code
      // denied the 4th — the epoch-sentinel bucket (period_start = 1970-01-01)
      // booked every prior call under one immortal per-"run" counter (RED,
      // captured).
      for (let call = 1; call <= 4; call += 1) {
        const result = await authorizer.authorizePromptBridge({
          claims,
          callerRef: CALLER_REF,
          purpose: 'stepless-run-cap-probe',
          idempotencyKey: `stepless-run-cap-${recipeName}-${call}`,
          payload: { call },
        })
        expect(
          result.ok,
          `call ${call}/4: per-run caps are deprecated and the authorizer must not deny (issue #348)${
            result.ok ? '' : ` — got ${result.error}: ${result.message}`
          }`
        ).toBe(true)
      }

      // Proves NO reset is required: even wiping the entire invocation audit
      // trail changes nothing about the decision (pre-change code kept denying
      // because the counter lives in plugin_workload_sdk_quota_counters, which
      // nothing ever resets for a stepless recipe).
      await db.pool.query(
        `DELETE FROM plugin_workload_sdk_invocations
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, recipeName]
      )
      const fifth = await authorizer.authorizePromptBridge({
        claims,
        callerRef: CALLER_REF,
        purpose: 'stepless-run-cap-probe',
        idempotencyKey: `stepless-run-cap-${recipeName}-5`,
        payload: { call: 5 },
      })
      expect(fifth.ok, '5th call after deleting every invocation row: still authorized').toBe(true)

      // The epoch-sentinel bucket was never touched: the entire authorization
      // path wrote ZERO rows to plugin_workload_sdk_quota_counters. A future
      // re-wire of the per-run leg inside the authorizer trips this loudly.
      expect(
        await quotaCounterRowCount(recipeName),
        'plugin_workload_sdk_quota_counters must receive no rows from the authorizer path'
      ).toBe(0)
    })

    it('mirrors the per-run-inert contract for clientNotifications through the AUTHORIZER', async () => {
      const recipeName = `stepless-notif-cap-${randomBytes(4).toString('hex')}`
      const eventType = 'lead.followup.due'
      await assertStepless(recipeName)
      await seedClientNotificationsGrant(recipeName, eventType, { maxNotificationsPerRun: 2 })
      const claims = claimsFor(recipeName)

      expect(await quotaCounterRowCount(recipeName), 'counters before any call').toBe(0)

      // THREE notifications — one past the declared per-run cap of 2 — each
      // with a fresh idempotency key. All must be authorized: the per-run cap
      // is deprecated and inert on the real enforcement path.
      for (let call = 1; call <= 3; call += 1) {
        const result = await authorizer.authorizeClientNotification({
          claims,
          callerRef: CALLER_REF,
          eventType,
          idempotencyKey: `stepless-notif-cap-${recipeName}-${call}`,
          payload: { call },
        })
        expect(
          result.ok,
          `notification ${call}/3: per-run caps are deprecated and the authorizer must not deny (issue #348)${
            result.ok ? '' : ` — got ${result.error}: ${result.message}`
          }`
        ).toBe(true)
      }

      expect(
        await quotaCounterRowCount(recipeName),
        'plugin_workload_sdk_quota_counters must receive no rows from the notification authorizer path'
      ).toBe(0)
    })

    it('enforces the per-minute window from the audit trail and frees after 61 seconds (backdated)', async () => {
      // promptBridge at the 180/min platform default: 181 in-window rows deny.
      const bridgeRecipe = `stepless-window-bridge-${randomBytes(4).toString('hex')}`
      await assertStepless(bridgeRecipe)
      await seedPromptBridgeGrant(bridgeRecipe, {})
      const bridgeGrant = await (async () => {
        const sdkDb = await import('../src/services/pluginWorkloadSdkDb.js')
        const grant = await sdkDb.findGrant(NS, bridgeRecipe, 'promptBridge')
        if (!grant) throw new Error(`seeded promptBridge grant not found for ${bridgeRecipe}`)
        return grant
      })()
      await seedInvocationWindowRows(bridgeRecipe, 'promptBridge', 'window-probe', 181)

      await expect(
        quotaTracker.checkRateLimit(NS, bridgeRecipe, 'promptBridge', bridgeGrant)
      ).resolves.toMatchObject({
        ok: false,
        error: 'quota_exceeded',
        retryable: false,
        message: expect.stringContaining('180/minute'),
      })

      // Backdate the whole burst out of the trailing minute (the window clock is
      // Postgres now(), plan D9 R2 — no fake timers, no real waiting) → allowed.
      await db.pool.query(
        `UPDATE plugin_workload_sdk_invocations
          SET created_at = now() - interval '61 seconds'
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, bridgeRecipe]
      )
      await expect(
        quotaTracker.checkRateLimit(NS, bridgeRecipe, 'promptBridge', bridgeGrant)
      ).resolves.toEqual({ ok: true })

      // clientNotifications mirror at the 200/min platform default, narrowed to
      // the eventType (detail column).
      const notifRecipe = `stepless-window-notif-${randomBytes(4).toString('hex')}`
      await assertStepless(notifRecipe)
      await seedClientNotificationsGrant(notifRecipe, 'lead.followup.due', {})
      const notifGrant = await (async () => {
        const sdkDb = await import('../src/services/pluginWorkloadSdkDb.js')
        const grant = await sdkDb.findGrant(NS, notifRecipe, 'clientNotifications')
        if (!grant) throw new Error(`seeded clientNotifications grant not found for ${notifRecipe}`)
        return grant
      })()
      await seedInvocationWindowRows(notifRecipe, 'clientNotifications', 'lead.followup.due', 201)

      await expect(
        quotaTracker.checkRateLimit(NS, notifRecipe, 'clientNotifications', notifGrant, {
          eventType: 'lead.followup.due',
        })
      ).resolves.toMatchObject({
        ok: false,
        error: 'quota_exceeded',
        retryable: false,
        message: expect.stringContaining('200/minute'),
      })

      await db.pool.query(
        `UPDATE plugin_workload_sdk_invocations
          SET created_at = now() - interval '61 seconds'
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, notifRecipe]
      )
      await expect(
        quotaTracker.checkRateLimit(NS, notifRecipe, 'clientNotifications', notifGrant, {
          eventType: 'lead.followup.due',
        })
      ).resolves.toEqual({ ok: true })
    })

    it('leaves stale epoch-sentinel quota counters inert through the AUTHORIZER — upgraded clusters are freed without migration', async () => {
      const recipeName = `stepless-stale-counter-${randomBytes(4).toString('hex')}`
      await assertStepless(recipeName)
      await seedPromptBridgeGrant(recipeName, { maxRequestsPerRun: 3 })
      const claims = claimsFor(recipeName)

      // A poisoned counter row exactly as a pre-#348 cluster would carry it:
      // booked under the eager sentinel period (epoch) with a count far past
      // any conceivable cap.
      await db.pool.query(
        `INSERT INTO plugin_workload_sdk_quota_counters
         (recipe_namespace, recipe_name, period_start, prompt_bridge_count, notification_count)
       VALUES ($1, $2, to_timestamp(0), 999999, 0)`,
        [NS, recipeName]
      )

      // TARGET behavior: the stale sentinel row is historical data only — it
      // must not deny anything. Pre-change code read it (999999 + 1 > 3) and
      // denied (RED, captured); after Phase 1 the real enforcement entry point
      // never consults plugin_workload_sdk_quota_counters, so upgraded clusters
      // are freed with NO data migration (plan D8: rollout is non-breaking).
      const result = await authorizer.authorizePromptBridge({
        claims,
        callerRef: CALLER_REF,
        purpose: 'stale-sentinel-probe',
        idempotencyKey: `stale-sentinel-${recipeName}-1`,
        payload: { probe: 'stale-sentinel' },
      })
      expect(
        result.ok,
        `stale epoch-sentinel counter must be inert on the authorizer path${
          result.ok ? '' : ` — got ${result.error}: ${result.message}`
        }`
      ).toBe(true)

      // The poisoned row is untouched — historical data only, neither read for
      // enforcement nor written by the authorization pipeline.
      const counter = await db.pool.query<{
        n: number
        prompt_bridge_count: number
        epoch: boolean
      }>(
        `SELECT count(*)::int AS n,
              min(prompt_bridge_count)::int AS prompt_bridge_count,
              bool_and(period_start = to_timestamp(0)) AS epoch
         FROM plugin_workload_sdk_quota_counters
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [NS, recipeName]
      )
      expect(counter.rows[0], 'sentinel row must remain exactly as seeded').toEqual({
        n: 1,
        prompt_bridge_count: 999999,
        epoch: true,
      })
    })
  }
)
