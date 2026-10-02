import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import * as ts from 'typescript'

const testDir = dirname(fileURLToPath(import.meta.url))
const suites = [
  'services.adminAuthDelete.realPostgres.integration.test.ts',
  'services.controlAdminReplaceInviter.realPostgres.integration.test.ts',
  'services.directory.userRetirement.realPostgres.integration.test.ts',
]

// This test-only contract probe executes each actual source callback, not a
// copied teardown model. Imports, beforeAll and business tests never run; the
// administrative/query collaborators below cannot contact a real database.
function afterAllCallback(
  file: string,
  collaborators: Record<string, unknown>
): () => Promise<void> {
  const source = readFileSync(join(testDir, file), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const callbacks: ts.ArrowFunction[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'afterAll'
    ) {
      const callback = node.arguments[0]
      if (callback && ts.isArrowFunction(callback)) callbacks.push(callback)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  // Do not put AST nodes in failure output: their parents contain unrelated
  // fixture data. The witness is exactly one asynchronous source callback.
  expect(callbacks.length).toBe(1)
  const callback = callbacks[0]!
  expect(callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(
    true
  )
  const emitted = ts.transpileModule(`(${callback.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const hook = new Script(emitted, { filename: `${file}:afterAll-contract` }).runInNewContext(
    {
      querySpy: undefined,
      connectSpy: undefined,
      corePoolConnectSpy: undefined,
      database: 'teardown_contract',
      quoteIdent: (value: string) => `"${value}"`,
      ...collaborators,
    },
    { timeout: 1_000 }
  ) as () => Promise<void>
  expect(typeof hook).toBe('function')
  return hook
}

describe.each(suites)('%s teardown contract', file => {
  it('closes the administrative pool after the client-close helper rejects without waiting or dropping', async () => {
    const testPool = {}
    const error = new Error('client-close helper failed')
    const helper = vi.fn().mockRejectedValueOnce(error)
    const wait = vi.fn()
    const adminPool = { end: vi.fn().mockResolvedValue(undefined), query: vi.fn() }
    const hook = afterAllCallback(file, {
      testPool,
      adminPool,
      endPoolAndWaitForClients: helper,
      waitForDatabaseConnectionsToClose: wait,
    })

    await expect(hook()).rejects.toBe(error)

    expect(helper).toHaveBeenCalledExactlyOnceWith(testPool)
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    expect(wait).not.toHaveBeenCalled()
    expect(adminPool.query).not.toHaveBeenCalled()
  })

  it('waits for client closure, then server closure, then drops before closing the admin pool', async () => {
    const events: string[] = []
    const testPool = {}
    const helper = vi.fn(async () => {
      events.push('clients-closed')
    })
    const wait = vi.fn(async () => {
      events.push('server-closed')
    })
    const adminPool = {
      query: vi.fn(async () => {
        events.push('drop')
      }),
      end: vi.fn(async () => {
        events.push('admin-closed')
      }),
    }
    const hook = afterAllCallback(file, {
      testPool,
      adminPool,
      endPoolAndWaitForClients: helper,
      waitForDatabaseConnectionsToClose: wait,
    })

    await expect(hook()).resolves.toBeUndefined()

    expect(helper).toHaveBeenCalledExactlyOnceWith(testPool)
    expect(wait).toHaveBeenCalledExactlyOnceWith(adminPool, 'teardown_contract')
    expect(adminPool.query).toHaveBeenCalledExactlyOnceWith(
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    expect(events).toEqual(['clients-closed', 'server-closed', 'drop', 'admin-closed'])
  })

  it('still closes the test pool when no administrative pool was created', async () => {
    const testPool = {}
    const helper = vi.fn().mockResolvedValue(undefined)
    const wait = vi.fn()
    const hook = afterAllCallback(file, {
      testPool,
      adminPool: undefined,
      endPoolAndWaitForClients: helper,
      waitForDatabaseConnectionsToClose: wait,
    })

    await expect(hook()).resolves.toBeUndefined()

    expect(helper).toHaveBeenCalledExactlyOnceWith(testPool)
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('gfsStructuralIntegrity.realPostgres.integration.test.ts teardown contract', () => {
  const file = 'gfsStructuralIntegrity.realPostgres.integration.test.ts'

  it('closes the admin pool after helper rejection without terminating or dropping', async () => {
    const pool = {}
    const error = new Error('GFS client-close helper failed')
    const helper = vi.fn().mockRejectedValueOnce(error)
    const adminPool = { end: vi.fn().mockResolvedValue(undefined), query: vi.fn() }
    const hook = afterAllCallback(file, { pool, adminPool, endPoolAndWaitForClients: helper })

    await expect(hook()).rejects.toBe(error)

    expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    expect(adminPool.query).not.toHaveBeenCalled()
  })

  it('closes clients before termination and DROP, then closes the admin pool', async () => {
    const events: string[] = []
    const pool = {}
    const helper = vi.fn(async () => {
      events.push('clients-closed')
    })
    const adminPool = {
      query: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push('terminate')
        })
        .mockImplementationOnce(async () => {
          events.push('drop')
        }),
      end: vi.fn(async () => {
        events.push('admin-closed')
      }),
    }
    const hook = afterAllCallback(file, { pool, adminPool, endPoolAndWaitForClients: helper })

    await expect(hook()).resolves.toBeUndefined()

    expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
    expect(adminPool.query).toHaveBeenCalledTimes(2)
    expect(adminPool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT pg_terminate_backend(pid)'),
      ['teardown_contract']
    )
    expect(adminPool.query.mock.calls[0]?.[0]).toContain('pid <> pg_backend_pid()')
    expect(adminPool.query).toHaveBeenNthCalledWith(
      2,
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    expect(events).toEqual(['clients-closed', 'terminate', 'drop', 'admin-closed'])
  })

  it('still closes the GFS pool when no administrative pool was created', async () => {
    const pool = {}
    const helper = vi.fn().mockResolvedValue(undefined)
    const hook = afterAllCallback(file, {
      pool,
      adminPool: undefined,
      endPoolAndWaitForClients: helper,
    })

    await expect(hook()).resolves.toBeUndefined()

    expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
  })

  it.each(['termination', 'DROP'] as const)(
    'closes the admin pool when %s SQL fails',
    async phase => {
      const pool = {}
      const error = new Error(`GFS ${phase} SQL failed`)
      const helper = vi.fn().mockResolvedValue(undefined)
      const query = vi.fn()
      if (phase === 'DROP') query.mockResolvedValueOnce(undefined)
      query.mockRejectedValueOnce(error)
      const adminPool = { end: vi.fn().mockResolvedValue(undefined), query }
      const hook = afterAllCallback(file, { pool, adminPool, endPoolAndWaitForClients: helper })

      await expect(hook()).rejects.toBe(error)

      expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
      expect(query).toHaveBeenCalledTimes(phase === 'termination' ? 1 : 2)
      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT pg_terminate_backend(pid)'),
        ['teardown_contract']
      )
      if (phase === 'DROP') {
        expect(query).toHaveBeenNthCalledWith(2, 'DROP DATABASE IF EXISTS "teardown_contract"')
      }
      expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    }
  )
})

describe('services.mcpSecretRollbackPermit.realPostgres.integration.test.ts teardown contract', () => {
  const file = 'services.mcpSecretRollbackPermit.realPostgres.integration.test.ts'

  it('closes the admin pool on helper rejection without probing, terminating or dropping', async () => {
    const pool = {}
    const error = new Error('rollback-permit client-close helper failed')
    const helper = vi.fn().mockRejectedValueOnce(error)
    const adminPool = { end: vi.fn().mockResolvedValue(undefined), query: vi.fn() }
    const hook = afterAllCallback(file, {
      pool,
      adminPool,
      endPoolAndWaitForClients: helper,
      setImmediate,
    })

    await expect(hook()).rejects.toBe(error)

    expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
    expect(adminPool.query).not.toHaveBeenCalled()
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['quiescent', 'still active'] as const)(
    'closes clients before observing %s backends and cleaning the database',
    async state => {
      const events: string[] = []
      const pool = {}
      const helper = vi.fn(async () => {
        events.push('clients-closed')
      })
      const count = state === 'quiescent' ? '0' : '1'
      const adminPool = {
        query: vi.fn(async (sql: string) => {
          events.push(
            sql.includes('COUNT(*)')
              ? 'probe'
              : sql.includes('pg_terminate_backend')
                ? 'terminate'
                : 'drop'
          )
          return { rows: [{ count }] }
        }),
        end: vi.fn(async () => {
          events.push('admin-closed')
        }),
      }
      const hook = afterAllCallback(file, {
        pool,
        adminPool,
        endPoolAndWaitForClients: helper,
        setImmediate,
      })

      await expect(hook()).resolves.toBeUndefined()

      expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
      const probes = state === 'quiescent' ? 1 : 50
      expect(adminPool.query).toHaveBeenCalledTimes(probes + (state === 'quiescent' ? 1 : 2))
      expect(adminPool.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT COUNT(*)::text AS count'),
        ['teardown_contract']
      )
      if (state === 'still active') {
        expect(adminPool.query).toHaveBeenNthCalledWith(
          51,
          expect.stringContaining('SELECT pg_terminate_backend(pid)'),
          ['teardown_contract']
        )
      }
      expect(adminPool.query).toHaveBeenLastCalledWith(
        'DROP DATABASE IF EXISTS "teardown_contract"'
      )
      expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
      expect(events).toEqual([
        'clients-closed',
        ...Array(probes).fill('probe'),
        ...(state === 'still active' ? ['terminate'] : []),
        'drop',
        'admin-closed',
      ])
    }
  )

  it('closes the permit pool even when no admin pool exists', async () => {
    const pool = {}
    const helper = vi.fn().mockResolvedValue(undefined)
    const hook = afterAllCallback(file, {
      pool,
      adminPool: undefined,
      endPoolAndWaitForClients: helper,
      setImmediate,
    })

    await expect(hook()).resolves.toBeUndefined()

    expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
  })

  it.each(['probe', 'termination', 'DROP'] as const)(
    'closes the admin pool if %s SQL rejects',
    async phase => {
      const pool = {}
      const error = new Error(`rollback-permit ${phase} SQL failed`)
      const helper = vi.fn().mockResolvedValue(undefined)
      const query = vi.fn()
      if (phase === 'termination') {
        for (let i = 0; i < 50; i += 1) query.mockResolvedValueOnce({ rows: [{ count: '1' }] })
      } else if (phase === 'DROP') {
        query.mockResolvedValueOnce({ rows: [{ count: '0' }] })
      }
      query.mockRejectedValueOnce(error)
      const adminPool = { end: vi.fn().mockResolvedValue(undefined), query }
      const hook = afterAllCallback(file, {
        pool,
        adminPool,
        endPoolAndWaitForClients: helper,
        setImmediate,
      })

      await expect(hook()).rejects.toBe(error)

      expect(helper).toHaveBeenCalledExactlyOnceWith(pool)
      expect(query).toHaveBeenCalledTimes(phase === 'probe' ? 1 : phase === 'termination' ? 51 : 2)
      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT COUNT(*)::text AS count'),
        ['teardown_contract']
      )
      if (phase === 'termination') {
        expect(query).toHaveBeenLastCalledWith(
          expect.stringContaining('SELECT pg_terminate_backend(pid)'),
          ['teardown_contract']
        )
      } else if (phase === 'DROP') {
        expect(query).toHaveBeenLastCalledWith('DROP DATABASE IF EXISTS "teardown_contract"')
      }
      expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
    }
  )
})

describe('gfsReaderRole.realPostgres.integration.test.ts teardown contract', () => {
  const file = 'gfsReaderRole.realPostgres.integration.test.ts'

  // Only collaborator markers are constructed here. Role/SQL/helper order is
  // supplied by the real source callback, never implemented by this fixture.
  function readerTeardown() {
    const readerPool = { identity: 'reader' }
    const writerPool = { identity: 'writer' }
    const pool = { query: vi.fn().mockResolvedValue(undefined) }
    const helper = vi.fn().mockResolvedValue(undefined)
    const adminPool = {
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const collaborators = {
      readerPool,
      writerPool,
      pool,
      adminPool,
      inheritedRole: 'teardown_inherited_role',
      endPoolAndWaitForClients: helper,
    }
    return { readerPool, writerPool, pool, helper, adminPool, collaborators }
  }

  it.each(['reader', 'writer', 'core'] as const)(
    'closes the admin pool if the %s helper rejects',
    async phase => {
      const fixture = readerTeardown()
      const error = new Error(`${phase} client-close helper failed`)
      const events: string[] = []
      const orderedPools = [fixture.readerPool, fixture.writerPool, fixture.pool]
      const failedIndex = phase === 'reader' ? 0 : phase === 'writer' ? 1 : 2
      fixture.helper.mockImplementation(async candidate => {
        if (candidate === orderedPools[failedIndex]) {
          events.push('helper-failed')
          throw error
        }
      })
      fixture.pool.query.mockImplementation(async () => {
        events.push('role-cleanup')
      })
      fixture.adminPool.end.mockImplementation(async () => {
        events.push('admin-closed')
      })
      const hook = afterAllCallback(file, fixture.collaborators)

      await expect(hook()).rejects.toBe(error)

      expect(fixture.helper).toHaveBeenCalledTimes(failedIndex + 1)
      for (let i = 0; i <= failedIndex; i += 1)
        expect(fixture.helper.mock.calls[i]?.[0]).toBe(orderedPools[i])
      expect(fixture.pool.query).toHaveBeenCalledTimes(phase === 'core' ? 3 : 0)
      expect(fixture.adminPool.query).not.toHaveBeenCalled()
      expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
      expect(events.slice(events.indexOf('helper-failed') + 1)).toEqual(['admin-closed'])
    }
  )

  it('preserves role isolation and helper/termination/DROP ordering', async () => {
    const fixture = readerTeardown()
    const events: string[] = []
    fixture.helper.mockImplementation(async candidate => {
      events.push(
        candidate === fixture.readerPool
          ? 'reader-closed'
          : candidate === fixture.writerPool
            ? 'writer-closed'
            : 'core-closed'
      )
    })
    fixture.pool.query.mockImplementation(async () => {
      events.push('role-cleanup')
    })
    fixture.adminPool.query
      .mockImplementationOnce(async () => {
        events.push('terminate')
      })
      .mockImplementationOnce(async () => {
        events.push('drop')
      })
    fixture.adminPool.end.mockImplementation(async () => {
      events.push('admin-closed')
    })
    const hook = afterAllCallback(file, fixture.collaborators)

    await expect(hook()).resolves.toBeUndefined()

    expect(fixture.helper).toHaveBeenCalledTimes(3)
    expect(fixture.helper.mock.calls[0]?.[0]).toBe(fixture.readerPool)
    expect(fixture.helper.mock.calls[1]?.[0]).toBe(fixture.writerPool)
    expect(fixture.helper.mock.calls[2]?.[0]).toBe(fixture.pool)
    expect(fixture.pool.query).toHaveBeenCalledTimes(3)
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      1,
      'ALTER ROLE gfs_controller NOLOGIN NOINHERIT'
    )
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      2,
      'ALTER ROLE gfs_controller_reader NOLOGIN NOINHERIT'
    )
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      3,
      'DROP ROLE IF EXISTS "teardown_inherited_role"'
    )
    expect(fixture.adminPool.query).toHaveBeenCalledTimes(2)
    expect(fixture.adminPool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT pg_terminate_backend(pid)'),
      ['teardown_contract']
    )
    expect(fixture.adminPool.query.mock.calls[0]?.[0]).toContain('pid <> pg_backend_pid()')
    expect(fixture.adminPool.query).toHaveBeenNthCalledWith(
      2,
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
    expect(events).toEqual([
      'reader-closed',
      'writer-closed',
      'role-cleanup',
      'role-cleanup',
      'role-cleanup',
      'core-closed',
      'terminate',
      'drop',
      'admin-closed',
    ])
  })

  it('closes every pool and attempts role isolation without an admin pool', async () => {
    const fixture = readerTeardown()
    const hook = afterAllCallback(file, { ...fixture.collaborators, adminPool: undefined })

    await expect(hook()).resolves.toBeUndefined()

    expect(fixture.helper).toHaveBeenCalledTimes(3)
    expect(fixture.helper.mock.calls[0]?.[0]).toBe(fixture.readerPool)
    expect(fixture.helper.mock.calls[1]?.[0]).toBe(fixture.writerPool)
    expect(fixture.helper.mock.calls[2]?.[0]).toBe(fixture.pool)
    expect(fixture.pool.query).toHaveBeenCalledTimes(3)
    expect(fixture.adminPool.query).not.toHaveBeenCalled()
    expect(fixture.adminPool.end).not.toHaveBeenCalled()
  })

  it.each(['termination', 'DROP'] as const)(
    'closes the admin pool when reader cleanup %s SQL rejects',
    async phase => {
      const fixture = readerTeardown()
      const error = new Error(`reader cleanup ${phase} SQL failed`)
      if (phase === 'DROP') fixture.adminPool.query.mockResolvedValueOnce(undefined)
      fixture.adminPool.query.mockRejectedValueOnce(error)
      const hook = afterAllCallback(file, fixture.collaborators)

      await expect(hook()).rejects.toBe(error)

      expect(fixture.helper).toHaveBeenCalledTimes(3)
      expect(fixture.pool.query).toHaveBeenCalledTimes(3)
      expect(fixture.adminPool.query).toHaveBeenCalledTimes(phase === 'termination' ? 1 : 2)
      expect(fixture.adminPool.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT pg_terminate_backend(pid)'),
        ['teardown_contract']
      )
      if (phase === 'DROP')
        expect(fixture.adminPool.query).toHaveBeenLastCalledWith(
          'DROP DATABASE IF EXISTS "teardown_contract"'
        )
      expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
    }
  )

  it('preserves the existing best-effort role cleanup while still attempting every isolation query', async () => {
    const fixture = readerTeardown()
    fixture.pool.query.mockRejectedValue(new Error('role cleanup unavailable'))
    const hook = afterAllCallback(file, fixture.collaborators)

    await expect(hook()).resolves.toBeUndefined()

    expect(fixture.pool.query).toHaveBeenCalledTimes(3)
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      1,
      'ALTER ROLE gfs_controller NOLOGIN NOINHERIT'
    )
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      2,
      'ALTER ROLE gfs_controller_reader NOLOGIN NOINHERIT'
    )
    expect(fixture.pool.query).toHaveBeenNthCalledWith(
      3,
      'DROP ROLE IF EXISTS "teardown_inherited_role"'
    )
    expect(fixture.helper).toHaveBeenCalledTimes(3)
    expect(fixture.adminPool.query).toHaveBeenCalledTimes(2)
    expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('actual spy-restoration failure cleanup', () => {
  it.each([
    { file: suites[0]!, spy: 'querySpy' },
    { file: suites[0]!, spy: 'connectSpy' },
    { file: suites[1]!, spy: 'querySpy' },
    { file: suites[1]!, spy: 'connectSpy' },
    { file: suites[2]!, spy: 'corePoolConnectSpy' },
  ])('$file closes the admin pool when $spy restoration throws', async ({ file, spy }) => {
    const error = new Error('spy restoration failed')
    const restorations = {
      querySpy: { mockRestore: vi.fn() },
      connectSpy: { mockRestore: vi.fn() },
      corePoolConnectSpy: { mockRestore: vi.fn() },
    }
    restorations[spy as keyof typeof restorations].mockRestore.mockImplementation(() => {
      throw error
    })
    const helper = vi.fn().mockResolvedValue(undefined)
    const wait = vi.fn()
    const adminPool = { end: vi.fn().mockResolvedValue(undefined), query: vi.fn() }
    const hook = afterAllCallback(file, {
      ...restorations,
      testPool: {},
      adminPool,
      endPoolAndWaitForClients: helper,
      waitForDatabaseConnectionsToClose: wait,
    })

    await expect(hook()).rejects.toBe(error)

    expect(
      restorations[spy as keyof typeof restorations].mockRestore
    ).toHaveBeenCalledExactlyOnceWith()
    expect(helper).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
    expect(adminPool.query).not.toHaveBeenCalled()
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('db.codexSubscriptionConnection.realPostgres.integration.test.ts teardown contract', () => {
  const file = 'db.codexSubscriptionConnection.realPostgres.integration.test.ts'

  it('closes the admin pool if the existing plain pool end rejects, without dropping', async () => {
    const error = new Error('Codex pool end failed')
    const pool = { end: vi.fn().mockRejectedValueOnce(error) }
    const adminPool = { query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) }
    const hook = afterAllCallback(file, { pool, adminPool })

    await expect(hook()).rejects.toBe(error)

    expect(pool.end).toHaveBeenCalledExactlyOnceWith()
    expect(adminPool.query).not.toHaveBeenCalled()
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it('preserves the intentional DROP recovery and still closes the admin pool', async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) }
    const adminPool = {
      query: vi.fn().mockRejectedValueOnce(new Error('DROP failed')),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const hook = afterAllCallback(file, { pool, adminPool })

    await expect(hook()).resolves.toBeUndefined()

    expect(pool.end).toHaveBeenCalledExactlyOnceWith()
    expect(adminPool.query).toHaveBeenCalledExactlyOnceWith(
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it('drops and closes the admin pool when no application pool was created', async () => {
    const adminPool = {
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const hook = afterAllCallback(file, { pool: undefined, adminPool })

    await expect(hook()).resolves.toBeUndefined()

    expect(adminPool.query).toHaveBeenCalledExactlyOnceWith(
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it('still ends the application pool without an admin pool', async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) }
    const hook = afterAllCallback(file, { pool, adminPool: undefined })

    await expect(hook()).resolves.toBeUndefined()

    expect(pool.end).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('routes.externalGfsRateLimitFailClosed.realPostgres.integration.test.ts teardown contract', () => {
  const file = 'routes.externalGfsRateLimitFailClosed.realPostgres.integration.test.ts'
  function routeTeardown() {
    // process is a local collaborator: these callbacks never alter the real
    // test runner's environment or execute the original module/beforeAll.
    const env = { RESTORE_PRESENT: 'temporary', RESTORE_ABSENT: 'temporary' } as Record<
      string,
      string
    >
    const previousEnv = new Map<string, string | undefined>([
      ['RESTORE_PRESENT', 'original'],
      ['RESTORE_ABSENT', undefined],
    ])
    const corePool = { identity: 'core' }
    const limiterPool = { identity: 'limiter' }
    const helper = vi.fn().mockResolvedValue(undefined)
    const adminPool = {
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const collaborators = {
      process: { env },
      envKeys: [...previousEnv.keys()],
      previousEnv,
      corePool,
      limiterPool,
      adminPool,
      endPoolAndWaitForClients: helper,
    }
    return { env, previousEnv, corePool, limiterPool, helper, adminPool, collaborators }
  }

  it('restores the environment and preserves existing helper recovery before SQL', async () => {
    const fixture = routeTeardown()
    fixture.helper.mockRejectedValue(new Error('caught client-close failure'))
    const hook = afterAllCallback(file, fixture.collaborators)

    await expect(hook()).resolves.toBeUndefined()

    expect(fixture.env).toEqual({ RESTORE_PRESENT: 'original' })
    expect(fixture.helper).toHaveBeenCalledTimes(2)
    expect(fixture.helper.mock.calls[0]?.[0]).toBe(fixture.corePool)
    expect(fixture.helper.mock.calls[1]?.[0]).toBe(fixture.limiterPool)
    expect(fixture.adminPool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT pg_terminate_backend(pid)'),
      ['teardown_contract']
    )
    expect(fixture.adminPool.query).toHaveBeenNthCalledWith(
      2,
      'DROP DATABASE IF EXISTS "teardown_contract"'
    )
    expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['termination', 'DROP'] as const)(
    'restores the environment and closes admin on %s rejection',
    async phase => {
      const fixture = routeTeardown()
      const error = new Error(`route ${phase} failed`)
      if (phase === 'DROP') fixture.adminPool.query.mockResolvedValueOnce(undefined)
      fixture.adminPool.query.mockRejectedValueOnce(error)
      const hook = afterAllCallback(file, fixture.collaborators)

      await expect(hook()).rejects.toBe(error)

      expect(fixture.env).toEqual({ RESTORE_PRESENT: 'original' })
      expect(fixture.helper).toHaveBeenCalledTimes(2)
      expect(fixture.adminPool.query).toHaveBeenCalledTimes(phase === 'termination' ? 1 : 2)
      expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
    }
  )

  it('closes admin and performs no helper/SQL work if environment restoration throws', async () => {
    const fixture = routeTeardown()
    const error = new Error('environment restoration failed')
    vi.spyOn(fixture.previousEnv, 'get').mockImplementation(() => {
      throw error
    })
    const hook = afterAllCallback(file, fixture.collaborators)

    await expect(hook()).rejects.toBe(error)

    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.adminPool.query).not.toHaveBeenCalled()
    expect(fixture.adminPool.end).toHaveBeenCalledExactlyOnceWith()
  })

  it('restores the environment and closes both application pools without admin', async () => {
    const fixture = routeTeardown()
    fixture.helper.mockRejectedValue(new Error('caught client-close failure'))
    const hook = afterAllCallback(file, { ...fixture.collaborators, adminPool: undefined })

    await expect(hook()).resolves.toBeUndefined()

    expect(fixture.env).toEqual({ RESTORE_PRESENT: 'original' })
    expect(fixture.helper).toHaveBeenCalledTimes(2)
    expect(fixture.adminPool.query).not.toHaveBeenCalled()
    expect(fixture.adminPool.end).not.toHaveBeenCalled()
  })
})
