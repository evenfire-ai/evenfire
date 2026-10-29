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
  'operational_relationship_target_idx',
  'operational_relationship_catalog_target_idx',
  'operational_relationship_generation_idx',
  'operational_resource_staging_identity_idx',
  'operational_relationship_staging_identity_idx',
  'invitation_delivery_commands_authorized_idx',
  'invitation_delivery_commands_invitation_idx',
])

const USER_ACCESS_FOUNDATION_VERSION = '0131_user_access_foundation'

describe('D34 migration execution policy', () => {
  it('classifies the five PR1 migrations that follow the dev batch', () => {
    expect(PR1_MIGRATION_VERSIONS).toEqual([
      '0131_user_access_foundation',
      '0132_invitation_delivery_commands',
      '0133_catalog_utf8_ordering',
      '0134_composable_catalog_revisions',
      '0135_legacy_password_security_epoch_backfill',
    ])
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0117_control_admin_invitation_replace_inviter')
    expect(PR1_MIGRATION_VERSIONS).not.toContain('0118_control_admin_replace_inviter_accept_guard')
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

  // Deploy hosts that copy only deploy/ and scripts/ (evenfire-infra, operator
  // overlays) run the migration script without control-api sources, so the
  // script reads the copy kept next to it.
  it('keeps the deploy script policy byte-identical to the runtime policy', async () => {
    const [runtimePolicy, deployPolicy] = await Promise.all([
      readFile(new URL('../src/migrations/migrationExecutionPolicy.json', import.meta.url)),
      readFile(
        new URL('../../deploy/scripts/control-api-migration-execution-policy.json', import.meta.url)
      ),
    ])
    expect(JSON.parse(runtimePolicy.toString('utf8'))).toEqual(MIGRATION_EXECUTION_POLICY)
    expect(deployPolicy.equals(runtimePolicy)).toBe(true)
  })

  it('classifies exactly 25 existing-table indexes and no fresh-table index', () => {
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(25)
    expect(new Set(PR1_ONLINE_INDEX_PLAN.map(index => index.name))).toHaveLength(25)
    expect(
      PR1_ONLINE_INDEX_PLAN.filter(index => index.migrationVersion.startsWith('0131'))
    ).toHaveLength(18)
    expect(
      PR1_ONLINE_INDEX_PLAN.filter(index => index.migrationVersion.startsWith('0133'))
    ).toHaveLength(7)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('external_user_sessions_'))
    ).toBe(false)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('invitation_delivery_commands_'))
    ).toBe(false)
  })

  it('pins the reviewed PR1 migration bodies byte-for-byte', async () => {
    // S1d changed the PR1 bodies before any shared environment applied them:
    // statement-level catalog triggers are no longer installed by the foundation
    // migration, the composable-revision migration replaces row triggers in place,
    // and planned indexes left the transactions. S1e folded three later PR1
    // migrations into those two and dropped the authorization_catalog_revision
    // table and function. PR1 now occupies slots 0131-0135, after dev's 0130.
    // The 2026-10-28 review (still unapplied anywhere) dropped unused objects,
    // made revision tables read-only for the runtime, ordered revision writers,
    // kept the Admin UI attribution sentinel, added three revision triggers and
    // a pre-lock for archive batches, now locking parents before revisions.
    // RP-3 (PR #334 review r2) added the approval-batch pre-lock, which also
    // covers the runs its DELETE cascade rewrites; RP-12 narrowed the
    // session-revocation ledger to SELECT and INSERT. O1 added the
    // approval-trigger pre-lock that both decision call sites take before they
    // bump the approval target. CR-1 (PR #334 review r2) added the recipe-delete
    // pre-lock, which the Workflow Recipes runtime executes and which locks the
    // recipe's grant rows inside the function before any revision. The run
    // revision trigger now returns early on
    // an UPDATE that changes none of the columns catalog consumers read, so
    // reconciler heartbeats stop bumping team and user revisions; the GFS
    // resource trigger does the same for content saves that keep its identity,
    // name, parent and tombstone.
    const files = [
      [
        'src/services/access/userAccessFoundationSchema.ts',
        '3d40cc6e9d131a86b484c1f5eb9ef047dd00ffff794cd8c0a62b199ecc94dd4b',
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

  it('classifies every PR1 index exactly once', async () => {
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
    const inTransactionNames = historicalSql
      .flatMap(sql => [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)])
      .map(match => match[1]!)
      .sort()
    const plannedNames = PR1_ONLINE_INDEX_PLAN.map(index => index.name).sort()

    // Only indexes on tables PR1 itself creates are built inside a transaction;
    // every index on a pre-existing table is built online, and only online.
    expect(inTransactionNames).toEqual([...FRESH_TABLE_INDEXES].sort())
    expect(plannedNames).toHaveLength(25)
    // 25 online plus 13 fresh-table indexes (P-12 removed the duplicate source index).
    expect(new Set([...plannedNames, ...inTransactionNames])).toHaveLength(38)

    // The planned definitions equal the in-transaction definitions S1d removed
    // (canonical form at 579ed2986), so an index built by either path is equivalent.
    const canonical = (value: string) =>
      value
        .replace(/\bCONCURRENTLY\b|\bIF NOT EXISTS\b/g, '')
        .replace(/;\s*$/, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim()
    const plannedDefinitions = [...PR1_ONLINE_INDEX_PLAN]
      .sort((left, right) => (left.name < right.name ? -1 : 1))
      .map(index => `${index.name}\t${canonical(index.createSql)}`)
      .join('\n')
    expect(createHash('sha256').update(plannedDefinitions).digest('hex')).toBe(
      'bc94e081bba8daa3708eb783a2c9abaf64e72fdfdf11d1b74ac6ba1926e834d2'
    )
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
  it('records an accepted PR1 alias receipt in its own transaction without replaying the body', async () => {
    const transactions: string[] = []
    let transaction = 0
    const aliasedVersion: string = PR1_MIGRATION_VERSIONS[1]
    const alias = 'synthetic_pr1_alias'
    const migrations = PR1_MIGRATION_VERSIONS.map(version => ({
      version,
      ...(version === aliasedVersion ? { legacyVersions: [alias] } : {}),
      apply: vi.fn(async () => undefined),
    }))
    const appliedVersions = new Set<string>([
      ...PR1_MIGRATION_VERSIONS.filter(version => version !== aliasedVersion),
      alias,
    ])
    const recorded: string[] = []
    await applyPendingPr1Migrations({
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') {
            transaction += 1
            transactions.push(`begin:${transaction}`)
          }
          if (sql === 'COMMIT') transactions.push(`commit:${transaction}`)
          if (sql === 'ROLLBACK') transactions.push(`rollback:${transaction}`)
          return { rows: [], rowCount: 0 }
        }),
      },
      migrations,
      appliedVersions,
      recordMigration: async (_db, version) => {
        recorded.push(version)
        transactions.push(`receipt:${transaction}:${version}`)
      },
    })

    expect(recorded).toEqual([aliasedVersion])
    expect(transactions).toEqual(['begin:1', `receipt:1:${aliasedVersion}`, 'commit:1'])
    for (const migration of migrations)
      expect(migration.apply, migration.version).not.toHaveBeenCalled()
    expect(appliedVersions).toContain(aliasedVersion)
  })

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

    expect(applied).toEqual([...PR1_MIGRATION_VERSIONS])
    // One transaction per version, plus the catalog_utf8_bytes function that
    // 0133 creates and commits before building its online indexes.
    const transactions = PR1_MIGRATION_VERSIONS.length + 1
    expect(queries.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(transactions)
    expect(queries.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(transactions)
    expect(queries.filter(({ sql }) => sql === 'ROLLBACK')).toHaveLength(0)
  })

  it('stops after a failed version and rolls back only that version', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const applyOrder: string[] = []
    const migrations = [
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
          ...PR1_ONLINE_INDEX_PLAN.map(index => `legacy_${index.migrationVersion}`),
        ]),
        recordMigration: async () => undefined,
      })
    ).rejects.toThrow('boom')
    expect(applyOrder).not.toContain(PR1_MIGRATION_VERSIONS[4])
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('fails closed for an unclassified migration after the dev batch', async () => {
    await expect(
      applyPendingPr1Migrations({
        db: { query: vi.fn() },
        migrations: [
          ...PR1_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          { version: '0199_unclassified', apply: vi.fn() },
        ],
        appliedVersions: new Set(),
        recordMigration: vi.fn(),
      })
    ).rejects.toThrow('Unclassified post-dev migrations: 0199_unclassified')
  })

  it('rejects a historical alias that collides with a canonical DEV identity', async () => {
    const migrations = [
      { version: '0129_workflow_schedules_concurrency_policy', apply: vi.fn() },
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        ...(version === USER_ACCESS_FOUNDATION_VERSION
          ? { legacyVersions: ['0129_workflow_schedules_concurrency_policy'] }
          : {}),
        apply: vi.fn(),
      })),
    ]
    await expect(
      applyPendingPr1Migrations({
        db: { query: vi.fn() },
        migrations,
        appliedVersions: new Set(),
        recordMigration: vi.fn(),
      })
    ).rejects.toThrow(
      'Migration alias collides with canonical version: 0129_workflow_schedules_concurrency_policy'
    )
  })

  it('leaves dev migrations to the initDb dev batch and applies only PR1 versions', async () => {
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
    const devMigrations = [
      '0129_workflow_schedules_concurrency_policy',
      '0130_password_login_success_admission',
    ].map(version => ({ version, apply: vi.fn(async () => undefined) }))
    await applyPendingPr1Migrations({
      db,
      migrations: [
        ...devMigrations,
        ...PR1_MIGRATION_VERSIONS.map(version => ({
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

    const expectedOrder = [...PR1_MIGRATION_VERSIONS]
    expect(applyOrder).toEqual(expectedOrder)
    expect(recorded).toEqual(expectedOrder)
    for (const migration of devMigrations) {
      expect(migration.apply, migration.version).not.toHaveBeenCalled()
    }
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
