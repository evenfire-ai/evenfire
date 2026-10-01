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
