import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MIGRATION_EXECUTION_POLICY } from '../src/migrations/migrationExecutionPolicy.js'
import {
  DEV_POST_0106_MIGRATION_VERSIONS,
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
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

const USER_ACCESS_FOUNDATION_VERSION = '0125_user_access_foundation'
const AUTHORIZATION_REVISION_COMPATIBILITY_VERSION =
  '0138_authorization_revision_delete_compatibility'

function expectedMigrationExecutionOrder(versions: readonly string[]): string[] {
  const withoutCompatibility = versions.filter(
    version => version !== AUTHORIZATION_REVISION_COMPATIBILITY_VERSION
  )
  const foundationIndex = withoutCompatibility.indexOf(USER_ACCESS_FOUNDATION_VERSION)
  expect(foundationIndex).toBeGreaterThanOrEqual(0)
  withoutCompatibility.splice(foundationIndex + 1, 0, AUTHORIZATION_REVISION_COMPATIBILITY_VERSION)
  return withoutCompatibility
}

describe('D34 migration execution policy', () => {
  it('classifies inherited parent migrations before the re-slotted PR1 migrations', () => {
    expect(DEV_POST_0106_MIGRATION_VERSIONS.slice(-6)).toEqual([
      '0119_dynamic_clients_table',
      '0120_dynamic_clients_runtime_access',
      '0121_oauth_install_identity',
      '0122_durable_entity_change_feed',
      '0123_entity_change_checkpoint_cursor_convergence',
      '0124_entity_change_definer_search_path',
    ])
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0117_control_admin_invitation_replace_inviter')
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0118_control_admin_replace_inviter_accept_guard')
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0119_dynamic_clients_table')
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0120_dynamic_clients_runtime_access')
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0121_oauth_install_identity')
  })

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

  it('classifies exactly 26 existing-table indexes and no fresh-table index', () => {
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(26)
    expect(new Set(PR1_ONLINE_INDEX_PLAN.map(index => index.name))).toHaveLength(26)
    const countByMigrationVersion = Object.fromEntries(
      [...new Set(PR1_ONLINE_INDEX_PLAN.map(index => index.migrationVersion))]
        .sort()
        .map(version => [
          version,
          PR1_ONLINE_INDEX_PLAN.filter(index => index.migrationVersion === version).length,
        ])
    )
    expect(countByMigrationVersion).toEqual({
      '0125_user_access_foundation': 18,
      '0127_catalog_utf8_ordering': 7,
      '0131_workflow_authority_bindings': 1,
    })
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
        'ed9cb12a3141871ddb4da12a19a865dcf11797436e830357193a4c3f3afc8ab6',
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
      ...PR1_ONLINE_INDEX_PLAN.filter(
        index => index.migrationVersion !== '0131_workflow_authority_bindings'
      ).map(index => index.name),
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
      if (index.migrationVersion === '0131_workflow_authority_bindings') continue
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
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
      ...PR2_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
    ]

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions: new Set(),
      recordMigration: async (_db, version) => {
        applied.push(version)
      },
    })

    expect(applied).toEqual(
      expectedMigrationExecutionOrder([
        ...DEV_POST_0106_MIGRATION_VERSIONS,
        ...PR1_MIGRATION_VERSIONS,
        ...PR2_MIGRATION_VERSIONS,
      ])
    )
    expect(queries.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(34)
    expect(queries.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(34)
    expect(queries.filter(({ sql }) => sql === 'ROLLBACK')).toHaveLength(0)
  })

  it('runs after-schema online indexes outside the migration transaction before recording', async () => {
    const events: string[] = []
    const indexStates = new Map<string, Record<string, unknown>>()
    let inTransaction = false
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') inTransaction = true
        if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false
        if (sql.includes('FROM pg_class index_rel')) {
          const state = indexStates.get(String(values?.[0]))
          return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
        }
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          const entry = PR1_ONLINE_INDEX_PLAN.find(index => sql === index.createSql)
          if (entry) {
            events.push(`create:${inTransaction}`)
            indexStates.set(entry.name, {
              table_name: entry.table,
              indisunique: Boolean(entry.unique),
              indisvalid: true,
              definition: sql,
            })
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const pendingVersion = '0131_workflow_authority_bindings'
    const appliedVersions = new Set<string>([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
    ])
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS,
    ].map(version => ({
      version,
      apply: vi.fn(async () => {
        if (version === pendingVersion) events.push('apply')
      }),
    }))

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions,
      recordMigration: async (_db, version) => {
        if (version === pendingVersion) events.push('record')
      },
    })

    expect(events).toEqual(['apply', 'create:false', 'record'])
  })

  it('does not record an after-schema migration when its online index fails', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM pg_class index_rel')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) throw new Error('online index failed')
      return { rows: [], rowCount: 0 }
    })
    const pendingVersion = '0131_workflow_authority_bindings'
    const appliedVersions = new Set<string>([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
    ])
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS,
    ].map(version => ({ version, apply: vi.fn(async () => undefined) }))
    const recordMigration = vi.fn(async () => undefined)

    await expect(
      applyPendingPr1Migrations({
        db: { query },
        migrations,
        appliedVersions,
        recordMigration,
      })
    ).rejects.toThrow('online index failed')

    expect(recordMigration).not.toHaveBeenCalled()
    expect(appliedVersions).not.toContain(pendingVersion)
  })

  it('stops after a failed version and rolls back only that version', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const applyOrder: string[] = []
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        legacyVersions: [`legacy_${version}`],
        apply: vi.fn(async () => {
          applyOrder.push(version)
          if (version === PR1_MIGRATION_VERSIONS[3]) throw new Error('boom')
        }),
      })),
    ]
    await expect(
      applyPendingPr1Migrations({
        db: { query },
        migrations,
        appliedVersions: new Set([
          ...DEV_POST_0106_MIGRATION_VERSIONS,
          ...PR1_ONLINE_INDEX_PLAN.map(index => `legacy_${index.migrationVersion}`),
        ]),
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
          ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          ...PR1_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          ...PR2_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          { version: '010d_unclassified', apply: vi.fn() },
        ],
        appliedVersions: new Set(),
        recordMigration: vi.fn(),
      })
    ).rejects.toThrow('Unclassified post-0106 migrations')
  })

  it('applies classified dev-owned post-0106 migrations before PR1 migrations', async () => {
    const indexStates = new Map<string, Record<string, unknown>>()
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
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
      }),
    }
    const applyOrder: string[] = []
    const recorded: string[] = []
    await applyPendingPr1Migrations({
      db,
      migrations: [
        ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
          version,
          apply: vi.fn(async () => {
            applyOrder.push(version)
          }),
        })),
        ...PR1_MIGRATION_VERSIONS.map(version => ({
          version,
          apply: vi.fn(async () => {
            applyOrder.push(version)
          }),
        })),
        ...PR2_MIGRATION_VERSIONS.map(version => ({
          version,
          apply: vi.fn(async () => {
            applyOrder.push(version)
          }),
        })),
      ],
      appliedVersions: new Set(),
      recordMigration: async (_db, version) => {
        recorded.push(version)
      },
    })

    const expectedOrder = expectedMigrationExecutionOrder([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS,
    ])
    expect(applyOrder).toEqual(expectedOrder)
    expect(recorded).toEqual(expectedOrder)
  })

  it('commits 0125 and its deletion-compatible successor as one migration phase', async () => {
    const events: string[] = []
    const transactionEvents: string[] = []
    let activeTransaction = 0
    let nextTransaction = 0
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
          transactionEvents.push(`${version}:apply:${activeTransaction}`)
        }),
      })),
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
          transactionEvents.push(`${version}:apply:${activeTransaction}`)
        }),
      })),
      ...PR2_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
          transactionEvents.push(`${version}:apply:${activeTransaction}`)
        }),
      })),
    ]
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') {
          activeTransaction = ++nextTransaction
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          activeTransaction = 0
        }
        if (sql.includes('FROM pg_class index_rel')) {
          const entry = PR1_ONLINE_INDEX_PLAN.find(index => index.name === values?.[0])
          return {
            rows: entry
              ? [
                  {
                    table_name: entry.table,
                    indisunique: Boolean(entry.unique),
                    indisvalid: true,
                    definition: entry.createSql,
                  },
                ]
              : [],
            rowCount: entry ? 1 : 0,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const applied = [...DEV_POST_0106_MIGRATION_VERSIONS]
    const expectedOrder = expectedMigrationExecutionOrder(PR1_MIGRATION_VERSIONS)

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions: new Set([...applied, ...PR2_MIGRATION_VERSIONS]),
      recordMigration: async (_db, version) => {
        events.push(`receipt:${version}`)
        transactionEvents.push(`${version}:receipt:${activeTransaction}`)
      },
    })

    expect(events.filter(event => !event.startsWith('receipt:'))).toEqual(expectedOrder)
    const parentIndex = events.indexOf(USER_ACCESS_FOUNDATION_VERSION)
    const parentReceiptIndex = events.indexOf(`receipt:${USER_ACCESS_FOUNDATION_VERSION}`)
    const compatibilityIndex = events.indexOf(AUTHORIZATION_REVISION_COMPATIBILITY_VERSION)
    const compatibilityReceiptIndex = events.indexOf(
      `receipt:${AUTHORIZATION_REVISION_COMPATIBILITY_VERSION}`
    )
    expect(parentIndex).toBeLessThan(parentReceiptIndex)
    expect(parentReceiptIndex).toBeLessThan(compatibilityIndex)
    expect(compatibilityIndex).toBeLessThan(compatibilityReceiptIndex)
    const phaseTransactionIds = [
      `${USER_ACCESS_FOUNDATION_VERSION}:apply`,
      `${USER_ACCESS_FOUNDATION_VERSION}:receipt`,
      `${AUTHORIZATION_REVISION_COMPATIBILITY_VERSION}:apply`,
      `${AUTHORIZATION_REVISION_COMPATIBILITY_VERSION}:receipt`,
    ].map(prefix => {
      const event = transactionEvents.find(candidate => candidate.startsWith(`${prefix}:`))
      return event?.split(':').at(-1)
    })
    expect(phaseTransactionIds).toHaveLength(4)
    expect(new Set(phaseTransactionIds).size).toBe(1)
    expect(phaseTransactionIds[0]).not.toBe('0')
    expect(db.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(
      PR1_MIGRATION_VERSIONS.length
    )
    expect(db.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(
      PR1_MIGRATION_VERSIONS.length
    )
  })

  it('repairs an applied 0125 prefix before preparing 0127 indexes', async () => {
    const events: string[] = []
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
        }),
      })),
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
        }),
      })),
      ...PR2_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => {
          events.push(version)
        }),
      })),
    ]
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          events.push(sql)
        }
        if (sql.includes('FROM pg_class index_rel')) {
          events.push('prepare:0127')
          const entry = PR1_ONLINE_INDEX_PLAN.find(index => index.name === values?.[0])
          return {
            rows: entry
              ? [
                  {
                    table_name: entry.table,
                    indisunique: Boolean(entry.unique),
                    indisvalid: true,
                    definition: entry.createSql,
                  },
                ]
              : [],
            rowCount: entry ? 1 : 0,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const appliedVersions = new Set([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS,
      USER_ACCESS_FOUNDATION_VERSION,
      '0126_invitation_delivery_commands',
      ...PR1_MIGRATION_VERSIONS.filter(
        version =>
          version !== USER_ACCESS_FOUNDATION_VERSION &&
          version !== '0126_invitation_delivery_commands' &&
          version !== '0127_catalog_utf8_ordering' &&
          version !== AUTHORIZATION_REVISION_COMPATIBILITY_VERSION
      ),
    ])

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions,
      recordMigration: async (_db, version) => {
        events.push(`receipt:${version}`)
      },
    })

    expect(events.indexOf(AUTHORIZATION_REVISION_COMPATIBILITY_VERSION)).toBeLessThan(
      events.indexOf('prepare:0127')
    )
    expect(events.indexOf(`receipt:${AUTHORIZATION_REVISION_COMPATIBILITY_VERSION}`)).toBeLessThan(
      events.indexOf('prepare:0127')
    )
    expect(events.filter(event => event === 'BEGIN')).toHaveLength(3)
    expect(events.filter(event => event === 'COMMIT')).toHaveLength(3)
    const repairCommit = events.indexOf('COMMIT')
    expect(repairCommit).toBeLessThan(events.indexOf('prepare:0127'))
  })

  it('preserves the 0125 alias when its 0138 successor is already recorded', async () => {
    const foundation = {
      version: USER_ACCESS_FOUNDATION_VERSION,
      legacyVersions: ['0109_user_access_foundation'],
      apply: vi.fn(async () => undefined),
    }
    const compatibility = {
      version: AUTHORIZATION_REVISION_COMPATIBILITY_VERSION,
      apply: vi.fn(async () => undefined),
    }
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
      ...PR1_MIGRATION_VERSIONS.filter(
        version =>
          version !== USER_ACCESS_FOUNDATION_VERSION &&
          version !== AUTHORIZATION_REVISION_COMPATIBILITY_VERSION
      ).map(version => ({ version, apply: vi.fn(async () => undefined) })),
      ...PR2_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: vi.fn(async () => undefined),
      })),
      foundation,
      compatibility,
    ]
    const appliedVersions = new Set([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS.filter(version => version !== USER_ACCESS_FOUNDATION_VERSION),
      '0109_user_access_foundation',
    ])
    const recorded: string[] = []

    await applyPendingPr1Migrations({
      db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
      migrations,
      appliedVersions,
      recordMigration: async (_db, version) => {
        recorded.push(version)
      },
    })

    expect(recorded).toEqual([USER_ACCESS_FOUNDATION_VERSION])
    expect(foundation.apply).not.toHaveBeenCalled()
    expect(compatibility.apply).not.toHaveBeenCalled()
    expect(appliedVersions).toContain(USER_ACCESS_FOUNDATION_VERSION)
  })

  it('fails closed when 0138 is recorded without the 0125 prerequisite', async () => {
    await expect(
      applyPendingPr1Migrations({
        db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
        migrations: [
          ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
            version,
            apply: vi.fn(async () => undefined),
          })),
          ...PR1_MIGRATION_VERSIONS.map(version => ({
            version,
            apply: vi.fn(async () => undefined),
          })),
        ],
        appliedVersions: new Set([
          ...DEV_POST_0106_MIGRATION_VERSIONS,
          AUTHORIZATION_REVISION_COMPATIBILITY_VERSION,
        ]),
        recordMigration: vi.fn(async () => undefined),
      })
    ).rejects.toThrow('recorded before its prerequisite')
  })
})

describe('D34 online-index recovery', () => {
  it.each([
    [
      'quoted identifier case',
      'CREATE INDEX idx ON team_members ("userId")',
      'CREATE INDEX idx ON team_members (userid)',
    ],
    [
      'significant expression grouping',
      'CREATE INDEX idx ON sample ((a + b) * c)',
      'CREATE INDEX idx ON sample (a + b * c)',
    ],
    [
      'column casts',
      'CREATE INDEX idx ON sample (value::text)',
      'CREATE INDEX idx ON sample (value)',
    ],
    [
      'quoted literal contents',
      "CREATE INDEX idx ON sample ((payload ->> 'userId'))",
      "CREATE INDEX idx ON sample ((payload ->> 'userid'))",
    ],
  ])('preserves %s in canonical definitions', (_case, left, right) => {
    expect(canonicalOnlineIndexDefinition(left)).not.toBe(canonicalOnlineIndexDefinition(right))
  })

  it('normalizes only harmless PostgreSQL index DDL decoration', () => {
    expect(
      canonicalOnlineIndexDefinition(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON sample (((a + b)))'
      )
    ).toBe(canonicalOnlineIndexDefinition('CREATE INDEX idx ON public.sample USING btree (a+b)'))
  })

  it('retains significant predicate grouping across boolean operators', () => {
    const grouped = `CREATE INDEX idx ON sample (value)
      WHERE ((first_value = 1 OR second_value = 2) AND third_value = 3)`
    const regrouped = `CREATE INDEX idx ON sample (value)
      WHERE first_value = 1 OR (second_value = 2 AND third_value = 3)`

    expect(canonicalOnlineIndexDefinition(grouped)).not.toBe(
      canonicalOnlineIndexDefinition(regrouped)
    )

    const precedence = `CREATE INDEX idx ON sample (value)
      WHERE first_value = 1 OR second_value = 2 AND third_value = 3`
    const explicitGrouping = `CREATE INDEX idx ON sample (value)
      WHERE (first_value = 1 OR second_value = 2) AND third_value = 3`
    expect(canonicalOnlineIndexDefinition(precedence)).not.toBe(
      canonicalOnlineIndexDefinition(explicitGrouping)
    )
  })

  it('retains text casts except at the fixed deparser coercion seams', () => {
    const castedColumn = 'CREATE INDEX idx ON sample (recipe_namespace::text)'
    const uncastColumn = 'CREATE INDEX idx ON sample (recipe_namespace)'
    expect(canonicalOnlineIndexDefinition(castedColumn)).not.toBe(
      canonicalOnlineIndexDefinition(uncastColumn)
    )
  })

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
