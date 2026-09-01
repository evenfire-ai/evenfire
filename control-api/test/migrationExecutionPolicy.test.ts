import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MIGRATION_EXECUTION_POLICY } from '../src/migrations/migrationExecutionPolicy.js'
import {
  PR1_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'
import {
  PR1_ONLINE_INDEX_PLAN,
  canonicalOnlineIndexDefinition,
  preparePr1Migration,
} from '../src/migrations/pr1OnlineIndexPlan.js'

const FRESH_TABLE_INDEXES = Object.freeze([
  'external_user_sessions_user_live_idx',
  'external_user_sessions_idle_idx',
  'external_v1_session_revocations_user_idx',
  'external_v1_session_revocations_expiry_idx',
  'authorization_resource_revisions_updated_idx',
  'operational_resource_source_idx',
  'operational_relationship_source_idx',
  'operational_relationship_target_idx',
  'operational_relationship_catalog_target_idx',
  'operational_relationship_generation_idx',
  'operational_resource_staging_identity_idx',
  'operational_relationship_staging_identity_idx',
  'invitation_delivery_commands_authorized_idx',
  'invitation_delivery_commands_invitation_idx',
])

describe('D34 migration execution policy', () => {
  it('freezes the owner-approved timeout and Job values', () => {
    expect(MIGRATION_EXECUTION_POLICY).toEqual({
      lockTimeoutMs: 10_000,
      ordinaryStatementTimeoutMs: 15_000,
      onlineIndexStatementTimeoutMs: 120_000,
      idleInTransactionTimeoutMs: 15_000,
      jobActiveDeadlineSeconds: 300,
      clientWaitSeconds: 360,
      terminationProofSeconds: 60,
      backoffLimit: 2,
      ttlSecondsAfterFinished: 600,
    })
  })

  it('classifies exactly 25 existing-table indexes and no fresh-table index', () => {
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(25)
    expect(new Set(PR1_ONLINE_INDEX_PLAN.map(index => index.name))).toHaveLength(25)
    expect(
      PR1_ONLINE_INDEX_PLAN.filter(index => index.migrationVersion.startsWith('0107'))
    ).toHaveLength(18)
    expect(
      PR1_ONLINE_INDEX_PLAN.filter(index => index.migrationVersion.startsWith('0109'))
    ).toHaveLength(7)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('external_user_sessions_'))
    ).toBe(false)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('invitation_delivery_commands_'))
    ).toBe(false)
  })

  it('preserves the approved historical migration bodies byte-for-byte', async () => {
    const files = [
      [
        'src/services/access/userAccessFoundationSchema.ts',
        'f1ff3491ca7fbb7b88300b9df570e2ee5672abc219a25086dcfdbb50a4c15c66',
      ],
      [
        'src/services/directory/invitationDeliverySchema.ts',
        'eafb103ae84541176c03486035503dda90eab91e55d881b643c2b5099493ee31',
      ],
    ] as const
    for (const [path, expected] of files) {
      const bytes = await readFile(new URL(`../${path}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(expected)
    }
  })

  it('classifies every immutable PR1 index exactly once', async () => {
    const historicalSql = await Promise.all([
      readFile(
        new URL('../src/services/access/userAccessFoundationSchema.ts', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../src/services/directory/invitationDeliverySchema.ts', import.meta.url),
        'utf8'
      ),
    ])
    const historicalNames = historicalSql
      .flatMap(sql => [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)])
      .map(match => match[1]!)
      .sort()
    const historicalDefinitions = new Map(
      historicalSql.flatMap(sql =>
        [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)[\s\S]*?;/g)].map(
          match => [match[1]!, match[0]] as const
        )
      )
    )
    const classified = [
      ...PR1_ONLINE_INDEX_PLAN.map(index => index.name),
      ...FRESH_TABLE_INDEXES,
    ].sort()

    expect(historicalNames).toHaveLength(39)
    expect(classified).toEqual(historicalNames)
    expect(new Set(classified)).toHaveLength(classified.length)
    const canonical = (value: string) =>
      value
        .replace(/\bCONCURRENTLY\b|\bIF NOT EXISTS\b/g, '')
        .replace(/;\s*$/, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim()
    for (const index of PR1_ONLINE_INDEX_PLAN) {
      expect(canonical(index.createSql), index.name).toBe(
        canonical(historicalDefinitions.get(index.name) ?? '')
      )
    }
  })

  it('normalizes PostgreSQL deparser syntax without accepting changed index tokens', () => {
    const expected = `CREATE INDEX workflow_runs_actor_catalog_idx
      ON workflow_runs (actor_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, team_id, usage_team_id)
      WHERE actor_type = 'user' AND actor_id IS NOT NULL`
    const deparsed = `CREATE INDEX workflow_runs_actor_catalog_idx
      ON public.workflow_runs USING btree (actor_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, team_id, usage_team_id)
      WHERE ((actor_type = 'user'::text) AND (actor_id IS NOT NULL))`
    const changed = deparsed.replace('(actor_id, run_id)', '(run_id, actor_id)')

    expect(canonicalOnlineIndexDefinition(deparsed)).toBe(canonicalOnlineIndexDefinition(expected))
    expect(canonicalOnlineIndexDefinition(changed)).not.toBe(
      canonicalOnlineIndexDefinition(expected)
    )

    const notificationExpected = `CREATE INDEX notification_user_catalog_idx
      ON notification_deliveries ((audience->>'userId'), id)
      INCLUDE (expires_at, status, event_type) WHERE audience ? 'userId'`
    const notificationDeparsed = `CREATE INDEX notification_user_catalog_idx
      ON public.notification_deliveries USING btree (((audience ->> 'userId'::text)), id)
      INCLUDE (expires_at, status, event_type) WHERE (audience ? 'userId'::text)`
    const nonEquivalentNotifications = [
      notificationDeparsed.replace('audience ->>', 'audience ->'),
      notificationDeparsed.replaceAll("'userId'", "'teamId'"),
      notificationDeparsed.replace(', id)', ', event_type)'),
      notificationDeparsed.replace('expires_at, status', 'expires_at, delivered_at'),
      notificationDeparsed.replace('WHERE (audience ?', 'WHERE (audience ='),
      notificationDeparsed.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
      notificationDeparsed.replace('notification_deliveries', 'notification_archive'),
    ]

    expect(canonicalOnlineIndexDefinition(notificationDeparsed)).toBe(
      canonicalOnlineIndexDefinition(notificationExpected)
    )
    for (const changed of nonEquivalentNotifications) {
      expect(canonicalOnlineIndexDefinition(changed)).not.toBe(
        canonicalOnlineIndexDefinition(notificationExpected)
      )
    }

    const workflowCatalogExpected = `CREATE INDEX user_workflow_triggers_catalog_utf8_idx
      ON user_workflow_triggers
      (user_id, catalog_utf8_bytes(recipe_namespace || '/' || recipe_name))`
    const workflowCatalogDeparsed = `CREATE INDEX user_workflow_triggers_catalog_utf8_idx
      ON public.user_workflow_triggers USING btree
      (user_id, catalog_utf8_bytes((((recipe_namespace)::text || '/'::text) ||
        (recipe_name)::text)))`
    const nonEquivalentWorkflowCatalog = [
      workflowCatalogDeparsed.replace("|| '/'::text", "+ '/'::text"),
      workflowCatalogDeparsed.replace('recipe_namespace', 'recipe_scope'),
      workflowCatalogDeparsed.replace('recipe_name', 'recipe_version'),
      workflowCatalogDeparsed.replace('(user_id,', '(team_id,'),
      workflowCatalogDeparsed.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
      workflowCatalogDeparsed.replace('user_workflow_triggers', 'team_workflow_triggers'),
    ]

    expect(canonicalOnlineIndexDefinition(workflowCatalogDeparsed)).toBe(
      canonicalOnlineIndexDefinition(workflowCatalogExpected)
    )
    for (const changed of nonEquivalentWorkflowCatalog) {
      expect(canonicalOnlineIndexDefinition(changed)).not.toBe(
        canonicalOnlineIndexDefinition(workflowCatalogExpected)
      )
    }
  })
})

describe('D34 PR1 migration runner', () => {
  it('commits and records each PR1 version independently in order', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = []
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values })
        if (sql.includes('FROM pg_class index_rel')) return { rows: [], rowCount: 0 }
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          const entry = PR1_ONLINE_INDEX_PLAN.find(index => sql === index.createSql)
          if (entry) indexStates.set(entry.name, { ...entry, indisvalid: true, definition: sql })
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const indexStates = new Map<string, Record<string, unknown>>()
    db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes('FROM pg_class index_rel')) {
        const state = indexStates.get(String(values?.[0]))
        return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
      }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
        const entry = PR1_ONLINE_INDEX_PLAN.find(index => sql === index.createSql)
        if (entry) {
          indexStates.set(entry.name, {
            table_name: entry.table,
            indisunique: Boolean(entry.unique),
            indisvalid: true,
            definition: sql,
          })
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const applied: string[] = []
    const migrations = PR1_MIGRATION_VERSIONS.map(version => ({
      version,
      apply: vi.fn(async () => undefined),
    }))

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions: new Set(),
      recordMigration: async (_db, version) => {
        applied.push(version)
      },
    })

    expect(applied).toEqual(PR1_MIGRATION_VERSIONS)
    expect(queries.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(7)
    expect(queries.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(7)
    expect(queries.filter(({ sql }) => sql === 'ROLLBACK')).toHaveLength(0)
  })

  it('stops after a failed version and rolls back only that version', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const applyOrder: string[] = []
    const migrations = PR1_MIGRATION_VERSIONS.map(version => ({
      version,
      legacyVersions: [`legacy_${version}`],
      apply: vi.fn(async () => {
        applyOrder.push(version)
        if (version === PR1_MIGRATION_VERSIONS[3]) throw new Error('boom')
      }),
    }))
    await expect(
      applyPendingPr1Migrations({
        db: { query },
        migrations,
        appliedVersions: new Set(
          PR1_ONLINE_INDEX_PLAN.map(index => `legacy_${index.migrationVersion}`)
        ),
        recordMigration: async () => undefined,
      })
    ).rejects.toThrow('boom')
    expect(applyOrder).not.toContain(PR1_MIGRATION_VERSIONS[4])
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('fails closed for an unclassified post-0106 migration', async () => {
    await expect(
      applyPendingPr1Migrations({
        db: { query: vi.fn() },
        migrations: [
          ...PR1_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          { version: '010d_unclassified', apply: vi.fn() },
        ],
        appliedVersions: new Set(),
        recordMigration: vi.fn(),
      })
    ).rejects.toThrow('Unclassified post-0106 migrations')
  })
})

describe('D34 online-index recovery', () => {
  it('repairs only an equivalent invalid index and rejects a different definition', async () => {
    const entry = PR1_ONLINE_INDEX_PLAN[0]!
    const states = new Map(
      PR1_ONLINE_INDEX_PLAN.filter(
        candidate => candidate.migrationVersion === entry.migrationVersion
      ).map(candidate => [
        candidate.name,
        {
          table_name: candidate.table,
          indisunique: Boolean(candidate.unique),
          indisvalid: candidate.name !== entry.name,
          definition: candidate.createSql,
        },
      ])
    )
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM pg_class index_rel')) {
        const state = states.get(String(values?.[0]))
        return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
      }
      if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
        states.delete(entry.name)
        return { rows: [], rowCount: 0 }
      }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
        const candidate = PR1_ONLINE_INDEX_PLAN.find(index => index.createSql === sql)!
        states.set(candidate.name, {
          table_name: candidate.table,
          indisunique: Boolean(candidate.unique),
          indisvalid: true,
          definition: candidate.createSql,
        })
      }
      return { rows: [], rowCount: 0 }
    })
    await preparePr1Migration({ query }, entry.migrationVersion)
    expect(query).toHaveBeenCalledWith(`DROP INDEX CONCURRENTLY ${entry.name}`)
    expect(query).toHaveBeenCalledWith(entry.createSql)

    states.set(entry.name, {
      ...states.get(entry.name)!,
      definition: 'CREATE INDEX wrong ON team_members (team_id)',
    })
    await expect(preparePr1Migration({ query }, entry.migrationVersion)).rejects.toThrow(
      `Non-equivalent existing index: ${entry.name}`
    )
  })
})
