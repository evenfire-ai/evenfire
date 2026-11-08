import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MIGRATION_EXECUTION_POLICY } from '../src/migrations/migrationExecutionPolicy.js'
import {
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'
import {
  PR1_ONLINE_INDEX_PLAN,
  PR2_ONLINE_INDEX_PLAN,
  PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS,
  expectedIndexDefinition,
  hasPostSchemaWork,
  onlineIndex,
  preparePr1Migration,
} from '../src/migrations/pr1OnlineIndexPlan.js'

const EARLIER_HEAD_GUARD_MARKER = '/* pr1-earlier-head-guard */'
const EARLIER_HEAD_DOC_REFERENCE =
  'see docs/deploy/user-access-foundation-upgrade.md#databases-that-ran-an-earlier-head-of-this-change'

type IndexStateRow = {
  schema_name: string
  table_name: string
  indisunique: boolean
  indisvalid: boolean
  definition: string
}

const PLANNED_INDEXES = [...PR1_ONLINE_INDEX_PLAN, ...PR2_ONLINE_INDEX_PLAN]
const VALIDATE_CONSTRAINT = /^ALTER TABLE (\w+) VALIDATE CONSTRAINT (\w+)$/

function plannedIndexState(entry: (typeof PR1_ONLINE_INDEX_PLAN)[number]): IndexStateRow {
  return {
    schema_name: 'public',
    table_name: entry.table,
    indisunique: Boolean(entry.unique),
    indisvalid: true,
    definition: expectedIndexDefinition(entry, 'public'),
  }
}

const FRESH_TABLE_INDEXES = Object.freeze([
  'external_user_sessions_user_live_idx',
  'external_user_sessions_idle_idx',
  'external_v1_session_revocations_user_idx',
  'external_v1_session_revocations_expiry_idx',
])

const USER_ACCESS_FOUNDATION_VERSION = '0137_user_access_foundation'

describe('D34 migration execution policy', () => {
  it('classifies the two PR1 migrations that follow the dev batch', () => {
    expect(PR1_MIGRATION_VERSIONS).toEqual([
      '0137_user_access_foundation',
      '0138_legacy_password_security_epoch_backfill',
    ])
    // PR2 follows dev's last migration (0138) in consecutive slots; 0145 keeps
    // its name.
    expect(PR2_MIGRATION_VERSIONS).toEqual([
      '0139_workflow_authority_bindings',
      '0140_gfs_upload_authority_bindings',
      '0141_pr2_readiness_evidence',
      '0142_pr2_runtime_privileges',
      '0143_workflow_recipe_authority_entity',
      '0144_workflow_run_failure_reason',
      '0145_workflow_authorization_pause',
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

  it('classifies exactly 5 existing-table indexes and no fresh-table index', () => {
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(5)
    expect(new Set(PR1_ONLINE_INDEX_PLAN.map(index => index.name))).toHaveLength(5)
    expect(
      PR1_ONLINE_INDEX_PLAN.filter(
        index => index.migrationVersion === USER_ACCESS_FOUNDATION_VERSION
      )
    ).toHaveLength(5)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('external_user_sessions_'))
    ).toBe(false)
    expect(
      PR1_ONLINE_INDEX_PLAN.some(index => index.name.startsWith('invitation_delivery_commands_'))
    ).toBe(false)
  })

  it('classifies the PR2 online indexes and the eight post-schema constraint validations', () => {
    expect(
      PR2_ONLINE_INDEX_PLAN.map(index => [
        index.migrationVersion,
        index.name,
        index.phase,
        index.replaces,
      ])
    ).toEqual([
      [
        '0139_workflow_authority_bindings',
        'workflow_runs_initiating_authority_binding',
        'after-schema',
        undefined,
      ],
      ['0145_workflow_authorization_pause', 'idx_wr_phase_v2', 'after-schema', 'idx_wr_phase'],
      ['0145_workflow_authorization_pause', 'idx_wr_owner_v2', 'after-schema', 'idx_wr_owner'],
    ])
    expect(
      PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS.map(entry => [
        entry.migrationVersion,
        entry.table,
        entry.constraint,
      ])
    ).toEqual([
      [
        '0139_workflow_authority_bindings',
        'workflow_runs',
        'workflow_runs_initiating_authority_binding_id_fkey',
      ],
      [
        '0139_workflow_authority_bindings',
        'workflow_approval_requests',
        'workflow_approval_requests_trigger_authority_binding_id_fkey',
      ],
      [
        '0139_workflow_authority_bindings',
        'workflow_approval_requests',
        'workflow_approval_requests_decision_authority_binding_id_fkey',
      ],
      [
        '0139_workflow_authority_bindings',
        'workflow_approval_requests',
        'workflow_approval_requests_consume_authority_binding_id_fkey',
      ],
      [
        '0140_gfs_upload_authority_bindings',
        'gfs_upload_sessions',
        'gfs_upload_sessions_action_authority_object',
      ],
      ['0144_workflow_run_failure_reason', 'workflow_runs', 'workflow_runs_failure_reason_check'],
      ['0145_workflow_authorization_pause', 'workflow_runs', 'workflow_runs_phase_check'],
      ['0145_workflow_authorization_pause', 'workflow_runs', 'workflow_runs_failure_reason_check'],
    ])
    // A version with only constraint validations (0140, 0144) still has
    // post-schema work; the versions without either have none.
    expect(PR2_MIGRATION_VERSIONS.filter(version => hasPostSchemaWork(version))).toEqual([
      '0139_workflow_authority_bindings',
      '0140_gfs_upload_authority_bindings',
      '0144_workflow_run_failure_reason',
      '0145_workflow_authorization_pause',
    ])
    expect(PR1_MIGRATION_VERSIONS.filter(version => hasPostSchemaWork(version))).toEqual([])
  })

  it('pins the reviewed PR1 migration bodies byte-for-byte', async () => {
    // PR1 occupies slots 0137-0138, after dev's 0136, and no shared
    // environment holds a receipt for either. 0137 creates the user-session
    // tables (sessions, security epochs, the v1 revocation ledger) and their
    // runtime grants; the indexes it needs on pre-existing tables are built
    // online by PR1_ONLINE_INDEX_PLAN. 0138 backfills the security epochs from
    // historical password events. PR1 installs no trigger and no function.
    const files = [
      [
        'src/services/access/userAccessFoundationSchema.ts',
        'de83799480ec54079f27e18abc5592780594e8b2d1a82759238a5edf1c8ff400',
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
    ])
    const inTransactionNames = historicalSql
      .flatMap(sql => [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)])
      .map(match => match[1]!)
      .sort()
    const plannedNames = PR1_ONLINE_INDEX_PLAN.map(index => index.name).sort()

    // Only indexes on tables PR1 itself creates are built inside a transaction;
    // every index on a pre-existing table is built online, and only online.
    expect(inTransactionNames).toEqual([...FRESH_TABLE_INDEXES].sort())
    expect(plannedNames).toHaveLength(5)
    // 5 online plus 4 fresh-table indexes.
    expect(new Set([...plannedNames, ...inTransactionNames])).toHaveLength(9)

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
      'ecb09f793b6d95cc9473a91270536e7e17184db23e808b8271625e9ed04a3e8f'
    )
  })

  it('derives every planned createSql as an online CREATE INDEX statement', () => {
    for (const index of PR1_ONLINE_INDEX_PLAN) {
      expect(index.createSql, index.name).toMatch(/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY /)
      expect(index.createSql, index.name).toBe(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${index.name} ON ${index.table} (${index.keys.join(', ')})` +
          (index.include ? ` INCLUDE (${index.include.join(', ')})` : '')
      )
    }
  })

  it('states the exact PostgreSQL 16 deparsed definition of a planned index', () => {
    const entry = PR1_ONLINE_INDEX_PLAN.find(
      index => index.name === 'team_members_user_active_idx'
    )!
    expect(expectedIndexDefinition(entry, 'public')).toBe(
      'CREATE INDEX team_members_user_active_idx ON public.team_members USING btree (user_id, status, team_id) INCLUDE (role, updated_at)'
    )
    const unique = onlineIndex({
      migrationVersion: USER_ACCESS_FOUNDATION_VERSION,
      name: 'synthetic_unique_idx',
      table: 'synthetic_table',
      unique: true,
      keys: ['value'],
    })
    expect(unique.createSql).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY synthetic_unique_idx ON synthetic_table (value)'
    )
    expect(expectedIndexDefinition(unique, 'tenant_schema')).toBe(
      'CREATE UNIQUE INDEX synthetic_unique_idx ON tenant_schema.synthetic_table USING btree (value)'
    )
    expect(() => expectedIndexDefinition(unique, 'Tenant-Schema')).toThrow(
      'Online index synthetic_unique_idx has a non-plain schema: "Tenant-Schema"'
    )
  })

  it.each([
    ['a quoted key', { keys: ['"userId"'] }, 'key'],
    ['a mixed-case key', { keys: ['userId'] }, 'key'],
    ['an expression key', { keys: ['a + b'] }, 'key'],
    ['a parenthesized key', { keys: ['(a)'] }, 'key'],
    ['an expression INCLUDE column', { keys: ['a'], include: ['lower(b)'] }, 'INCLUDE column'],
    ['a schema-qualified table', { keys: ['a'], table: 'public.sample' }, 'table'],
  ])('rejects %s at plan load', (_case, override, role) => {
    expect(() =>
      onlineIndex({
        migrationVersion: USER_ACCESS_FOUNDATION_VERSION,
        name: 'synthetic_idx',
        table: 'sample',
        ...override,
      })
    ).toThrow(`Online index synthetic_idx has a non-plain ${role}`)
  })

  it('rejects an index without keys or with an empty INCLUDE list', () => {
    const base = {
      migrationVersion: USER_ACCESS_FOUNDATION_VERSION,
      name: 'synthetic_idx',
      table: 'sample',
    } as const
    expect(() => onlineIndex({ ...base, keys: [] })).toThrow(
      'Online index synthetic_idx has no keys'
    )
    expect(() => onlineIndex({ ...base, keys: ['a'], include: [] })).toThrow(
      'Online index synthetic_idx has an empty INCLUDE list'
    )
  })
})

describe('D34 PR1 migration runner', () => {
  it('records an accepted PR1 alias receipt in its own transaction without replaying the body', async () => {
    const transactions: string[] = []
    let transaction = 0
    const aliasedVersion: string = PR1_MIGRATION_VERSIONS[1]
    const alias = 'synthetic_pr1_alias'
    const migrations = [
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        ...(version === aliasedVersion ? { legacyVersions: [alias] } : {}),
        apply: vi.fn(async () => undefined),
      })),
      ...PR2_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn(async () => undefined) })),
    ]
    const appliedVersions = new Set<string>([
      ...PR1_MIGRATION_VERSIONS.filter(version => version !== aliasedVersion),
      ...PR2_MIGRATION_VERSIONS,
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

  it('commits and records each runner version independently in order', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = []
    const indexStates = new Map<string, IndexStateRow>()
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values })
        if (sql.includes(EARLIER_HEAD_GUARD_MARKER)) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM pg_class index_rel')) {
          const state = indexStates.get(String(values?.[0]))
          return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
        }
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          const entry = PLANNED_INDEXES.find(index => sql === index.createSql)
          if (entry) indexStates.set(entry.name, plannedIndexState(entry))
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const applied: string[] = []
    const migrations = [
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

    expect(applied).toEqual([...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS])
    // One transaction per version without post-schema work (0137, 0138,
    // 0141-0143); a version with it commits its schema, each validation and
    // its receipt separately: 0139 1 + 4 + 1, 0140 1 + 1 + 1, 0144 1 + 1 + 1,
    // 0145 1 + 2 + 1.
    const transactions = 5 + 6 + 3 + 3 + 4
    expect(queries.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(transactions)
    expect(queries.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(transactions)
    expect(queries.filter(({ sql }) => sql === 'ROLLBACK')).toHaveLength(0)
    expect(queries.filter(({ sql }) => VALIDATE_CONSTRAINT.test(sql))).toHaveLength(8)
  })

  it('runs after-schema online indexes, then each constraint validation, before recording', async () => {
    const events: string[] = []
    const indexStates = new Map<string, IndexStateRow>()
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
          const entry = PLANNED_INDEXES.find(index => sql === index.createSql)
          if (entry) {
            events.push(`create:${entry.name}:${inTransaction}`)
            indexStates.set(entry.name, plannedIndexState(entry))
          }
        }
        // The online bound (120 s), not the ordinary 15 s bound every
        // bounded transaction sets first.
        if (sql === "SET LOCAL statement_timeout = '120000ms'") {
          events.push(`bound:120000ms:${inTransaction}`)
        }
        const validation = VALIDATE_CONSTRAINT.exec(sql)
        if (validation) events.push(`validate:${validation[2]}:${inTransaction}`)
        return { rows: [], rowCount: 0 }
      }),
    }
    const pendingVersion = '0139_workflow_authority_bindings'
    const appliedVersions = new Set<string>([
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
    ])
    const migrations = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS].map(version => ({
      version,
      apply: vi.fn(async () => {
        if (version === pendingVersion) events.push(`apply:${inTransaction}`)
      }),
    }))

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions,
      recordMigration: async (_db, version) => {
        if (version === pendingVersion) events.push(`record:${inTransaction}`)
      },
    })

    const validate = (constraint: string) => [`bound:120000ms:true`, `validate:${constraint}:true`]
    expect(events).toEqual([
      'apply:true',
      'create:workflow_runs_initiating_authority_binding:false',
      ...validate('workflow_runs_initiating_authority_binding_id_fkey'),
      ...validate('workflow_approval_requests_trigger_authority_binding_id_fkey'),
      ...validate('workflow_approval_requests_decision_authority_binding_id_fkey'),
      ...validate('workflow_approval_requests_consume_authority_binding_id_fkey'),
      'record:true',
    ])
  })

  it.each([
    ['0140_gfs_upload_authority_bindings', ['gfs_upload_sessions_action_authority_object']],
    ['0144_workflow_run_failure_reason', ['workflow_runs_failure_reason_check']],
  ])(
    'validates the constraints of %s, which has no online index, after its schema commits',
    async (pendingVersion, constraints) => {
      const events: string[] = []
      let inTransaction = false
      let transaction = 0
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') {
            inTransaction = true
            transaction += 1
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false
          const validation = VALIDATE_CONSTRAINT.exec(sql)
          if (validation) events.push(`validate:${validation[2]}:${transaction}:${inTransaction}`)
          return { rows: [], rowCount: 0 }
        }),
      }
      const appliedVersions = new Set<string>([
        ...PR1_MIGRATION_VERSIONS,
        ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
      ])
      const migrations = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS].map(version => ({
        version,
        apply: vi.fn(async () => {
          if (version === pendingVersion) events.push(`apply:${transaction}:${inTransaction}`)
        }),
      }))

      await applyPendingPr1Migrations({
        db,
        migrations,
        appliedVersions,
        recordMigration: async (_db, version) => {
          if (version === pendingVersion) events.push(`record:${transaction}:${inTransaction}`)
        },
      })

      expect(events).toEqual([
        'apply:1:true',
        ...constraints.map((constraint, index) => `validate:${constraint}:${index + 2}:true`),
        `record:${constraints.length + 2}:true`,
      ])
    }
  )

  it('surfaces a failed validation error itself, records nothing, and rolls that validation back', async () => {
    // A fake session that behaves as PostgreSQL does after a failed statement
    // inside a transaction: every statement but ROLLBACK is rejected with
    // 25P02 until the transaction ends. A cleanup statement issued inside the
    // aborted transaction would therefore replace the VALIDATE error.
    const queries: string[] = []
    const rejectedWhileAborted: string[] = []
    let inTransaction = false
    let aborted = false
    const validationError = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014' }
    )
    const query = vi.fn(async (sql: string) => {
      queries.push(sql)
      if (sql === 'ROLLBACK') {
        inTransaction = false
        aborted = false
        return { rows: [], rowCount: 0 }
      }
      if (aborted) {
        rejectedWhileAborted.push(sql)
        throw Object.assign(
          new Error(
            'current transaction is aborted, commands ignored until end of transaction block'
          ),
          { code: '25P02' }
        )
      }
      if (sql === 'BEGIN') inTransaction = true
      if (sql === 'COMMIT') inTransaction = false
      if (VALIDATE_CONSTRAINT.test(sql)) {
        if (inTransaction) aborted = true
        throw validationError
      }
      return { rows: [], rowCount: 0 }
    })
    const pendingVersion = '0144_workflow_run_failure_reason'
    const appliedVersions = new Set<string>([
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
    ])
    const migrations = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS].map(version => ({
      version,
      apply: vi.fn(async () => undefined),
    }))
    const recordMigration = vi.fn(async () => undefined)

    await expect(
      applyPendingPr1Migrations({
        db: { query },
        migrations,
        appliedVersions,
        recordMigration,
      })
    ).rejects.toBe(validationError)

    // Witness: the schema transaction committed and the validation was issued
    // once, inside its own transaction.
    expect(
      migrations.find(migration => migration.version === pendingVersion)!.apply
    ).toHaveBeenCalledTimes(1)
    expect(
      queries.filter(
        sql =>
          sql === 'ALTER TABLE workflow_runs VALIDATE CONSTRAINT workflow_runs_failure_reason_check'
      )
    ).toHaveLength(1)
    expect(queries.slice(-2)).toEqual([
      'ALTER TABLE workflow_runs VALIDATE CONSTRAINT workflow_runs_failure_reason_check',
      'ROLLBACK',
    ])
    expect(rejectedWhileAborted).toEqual([])
    expect(recordMigration).not.toHaveBeenCalled()
    expect(appliedVersions).not.toContain(pendingVersion)
  })

  it('does not record an after-schema migration when its online index fails', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM pg_class index_rel')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) throw new Error('online index failed')
      return { rows: [], rowCount: 0 }
    })
    const pendingVersion = '0139_workflow_authority_bindings'
    const appliedVersions = new Set<string>([
      ...PR1_MIGRATION_VERSIONS,
      ...PR2_MIGRATION_VERSIONS.filter(version => version !== pendingVersion),
    ])
    const migrations = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS].map(version => ({
      version,
      apply: vi.fn(async () => undefined),
    }))
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
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        legacyVersions: [`legacy_${version}`],
        apply: vi.fn(async () => {
          applyOrder.push(version)
          if (version === PR1_MIGRATION_VERSIONS[1]) throw new Error('boom')
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
    expect(applyOrder).not.toContain(PR1_MIGRATION_VERSIONS[0])
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('fails closed for an unclassified migration after the dev batch', async () => {
    await expect(
      applyPendingPr1Migrations({
        db: { query: vi.fn() },
        migrations: [
          ...PR1_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
          ...PR2_MIGRATION_VERSIONS.map(version => ({ version, apply: vi.fn() })),
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
    const indexStates = new Map<string, IndexStateRow>()
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes(EARLIER_HEAD_GUARD_MARKER)) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM pg_class index_rel')) {
          const state = indexStates.get(String(values?.[0]))
          return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
        }
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          const entry = PLANNED_INDEXES.find(index => sql === index.createSql)
          if (entry) indexStates.set(entry.name, plannedIndexState(entry))
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

    const expectedOrder = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS]
    expect(applyOrder).toEqual(expectedOrder)
    expect(recorded).toEqual(expectedOrder)
    for (const migration of devMigrations) {
      expect(migration.apply, migration.version).not.toHaveBeenCalled()
    }
  })
})

describe('PR1 earlier-head guard', () => {
  function guardedDb(guardRows: unknown[]) {
    const queries: Array<{ sql: string; values?: unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes(EARLIER_HEAD_GUARD_MARKER)) {
        return { rows: guardRows, rowCount: guardRows.length }
      }
      return { rows: [], rowCount: 0 }
    })
    return { db: { query }, queries }
  }

  function pr1Migrations(legacyVersionsFor: Record<string, readonly string[]> = {}) {
    return [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS].map(version => ({
      version,
      ...(legacyVersionsFor[version] ? { legacyVersions: legacyVersionsFor[version] } : {}),
      apply: vi.fn(async () => undefined),
    }))
  }

  it('rejects recorded earlier-head versions, including prefixes below 0130 and hexadecimal prefixes, before any PR1 work', async () => {
    const { db, queries } = guardedDb([])
    const migrations = pr1Migrations()
    const recordMigration = vi.fn()

    const rejection = applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions: new Set([
        '0129_workflow_schedules_concurrency_policy',
        '0130_password_login_success_admission',
        '0126_user_access_foundation',
        '0133_catalog_utf8_ordering',
        '0137_user_access_foundation',
        // The versions earlier heads recorded just below the current PR1 numbers.
        '0131_user_access_foundation',
        '0132_legacy_password_security_epoch_backfill',
        // Dev's own migrations under those same numbers: the exact message below
        // proves the guard reads the name, not the number.
        '0131_llm_provider_catalog_settings',
        '0132_llm_catalog_dismissed',
        // Earlier heads also recorded hexadecimal prefixes.
        '010a_invitation_delivery_commands',
        '012b_user_access_foundation_definer_temp_shadow_hardening',
        // A dev receipt with a hexadecimal prefix whose name is not an
        // earlier-head name: the exact message below proves it is not named.
        '00a0_codex_subscription_connections',
      ]),
      recordMigration,
    })

    await expect(rejection).rejects.toThrow(
      'recorded versions [010a_invitation_delivery_commands, 0126_user_access_foundation, 012b_user_access_foundation_definer_temp_shadow_hardening, 0131_user_access_foundation, 0132_legacy_password_security_epoch_backfill, 0133_catalog_utf8_ordering]; functions []; tables []; ' +
        EARLIER_HEAD_DOC_REFERENCE
    )
    // Liveness witness: the guard ran its catalog probe once, with the table list.
    const guardQueries = queries.filter(({ sql }) => sql.includes(EARLIER_HEAD_GUARD_MARKER))
    expect(guardQueries).toHaveLength(1)
    expect(guardQueries[0]!.values?.[0]).toHaveLength(12)
    expect(queries.map(({ sql }) => sql)).toEqual([guardQueries[0]!.sql])
    for (const migration of migrations) expect(migration.apply).not.toHaveBeenCalled()
    expect(recordMigration).not.toHaveBeenCalled()
  })

  it('rejects earlier-head functions and tables that the catalog probe finds', async () => {
    const { db, queries } = guardedDb([
      { kind: 'function', name: 'authorization_bump_user_revision(uuid)' },
      { kind: 'function', name: 'authorization_bump_user_row_revision()' },
      { kind: 'table', name: 'authorization_catalog_writer_components' },
    ])

    await expect(
      applyPendingPr1Migrations({
        db,
        migrations: pr1Migrations(),
        appliedVersions: new Set(['0131_invitation_delivery_commands']),
        recordMigration: vi.fn(),
      })
    ).rejects.toThrow(
      'recorded versions [0131_invitation_delivery_commands]; ' +
        'functions [authorization_bump_user_revision(uuid), authorization_bump_user_row_revision()]; ' +
        'tables [authorization_catalog_writer_components]; ' +
        EARLIER_HEAD_DOC_REFERENCE
    )
    expect(queries).toHaveLength(1)
  })

  it('accepts a registered alias of an earlier name and proceeds when the probe is empty', async () => {
    const { db, queries } = guardedDb([])
    const recorded: string[] = []
    const migrations = pr1Migrations({
      '0138_legacy_password_security_epoch_backfill': [
        '0134_legacy_password_security_epoch_backfill',
      ],
    })

    await applyPendingPr1Migrations({
      db,
      migrations,
      appliedVersions: new Set([
        '0137_user_access_foundation',
        '0134_legacy_password_security_epoch_backfill',
        ...PR2_MIGRATION_VERSIONS,
      ]),
      recordMigration: async (_db, version) => {
        recorded.push(version)
      },
    })

    expect(queries.filter(({ sql }) => sql.includes(EARLIER_HEAD_GUARD_MARKER))).toHaveLength(1)
    expect(recorded).toEqual(['0138_legacy_password_security_epoch_backfill'])
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
        { ...plannedIndexState(candidate), indisvalid: candidate.name !== entry.name },
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
        states.set(candidate.name, plannedIndexState(candidate))
      }
      return { rows: [], rowCount: 0 }
    })
    await preparePr1Migration({ query }, entry.migrationVersion)
    expect(query).toHaveBeenCalledWith(`DROP INDEX CONCURRENTLY ${entry.name}`)
    expect(query).toHaveBeenCalledWith(entry.createSql)

    // Exact comparison: the createSql text (not PostgreSQL's deparsed form) and
    // a reordered INCLUDE list are both rejected.
    for (const definition of [
      entry.createSql,
      expectedIndexDefinition(entry, 'public').replace(
        'INCLUDE (role, updated_at)',
        'INCLUDE (updated_at, role)'
      ),
      'CREATE INDEX wrong ON team_members (team_id)',
    ]) {
      states.set(entry.name, { ...plannedIndexState(entry), definition })
      await expect(preparePr1Migration({ query }, entry.migrationVersion)).rejects.toThrow(
        `Non-equivalent existing index: ${entry.name}`
      )
    }
  })
})
