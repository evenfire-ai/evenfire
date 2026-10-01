import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { verifyDevIsolationRuntime } from '../devIsolation'

// Execute the actual production startup callbacks with synthetic boundaries.
// Importing main itself would launch Electron and touch the user's OS state.
const source = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8')
const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
function callback(property: 'then' | 'catch'): ts.ArrowFunction {
  const matches: ts.ArrowFunction[] = []
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === property
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isArrowFunction(argument)) {
        const text = argument.getText(syntax)
        if (
          property === 'then'
            ? text.includes('verifyDevIsolationBeforeServices')
            : text.includes('mainWindowLifecycleReady')
        )
          matches.push(argument)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  expect(matches).toHaveLength(1)
  return matches[0]!
}
function evaluate(text: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const module = { exports: {} as any }
  const compiled = ts.transpileModule(`const selected = (${text}); module.exports = selected`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(compiled, { ...globals, module, exports: module.exports }, { timeout: 1000 })
  return module.exports
}
const ownedDirectories: string[] = []
afterEach(() => {
  for (const directory of ownedDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function verifiedFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-startup-isolation-'))
  fs.chmodSync(directory, 0o700)
  ownedDirectories.push(directory)
  const storagePath = path.join(directory, 'runtime-config.json')
  fs.writeFileSync(storagePath, '{}')
  const plan = { userDataDir: directory, appPath: directory }
  const app = {
    getPath: () => directory,
    getAppPath: () => directory,
    isReady: () => true,
    exit: vi.fn(),
  }
  const normalRequest = vi.fn()
  const globals = {
    app,
    fs,
    path,
    process: { pid: 825 },
    config: {
      externalRestApiBaseUrl: 'http://127.0.0.1:31001',
      rpcProxyBaseUrl: 'http://127.0.0.1:31002',
    },
    hydrateDesktopRuntimeConfig: vi.fn(),
    getDesktopRuntimeConfigState: () => ({ storagePath }),
    getActiveEnvKey: () => 'fixture-000000000001',
    verifyDevIsolationRuntime,
    console: { log: vi.fn(), error: vi.fn() },
    publicDevIsolationRecord: () => ({}),
    formatDevIsolationLogLine: () => 'synthetic public metadata',
    bindTokenStoreIsolation: () => {
      throw new Error('Synthetic binding failure')
    },
    requestMainWindow: normalRequest,
    devIsolationPlan: plan,
    mainWindowLifecycleReady: false,
  }
  return {
    directory,
    plan: {
      ...plan,
      restUrl: globals.config.externalRestApiBaseUrl,
      rpcUrl: globals.config.rpcProxyBaseUrl,
      configPath: storagePath,
    },
    app,
    globals,
    normalRequest,
  }
}
describe('actual isolated Desktop startup error path', () => {
  it('failed verified authentication binding returns false and never reaches services/window creation', async () => {
    const fixture = verifiedFixture()
    const declaration = syntax.statements.find(
      node =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'verifyDevIsolationBeforeServices'
    )
    expect(declaration).toBeDefined()
    const verify = evaluate(
      `function(plan) ${(declaration as ts.FunctionDeclaration).body!.getText(syntax)}`,
      fixture.globals
    )
    expect(verify(fixture.plan)).toBe(false)
    expect(fixture.app.exit).toHaveBeenCalledWith(1)
    const initialize = vi.fn()
    const run = evaluate(callback('then').getText(syntax), {
      ...fixture.globals,
      verifyDevIsolationBeforeServices: () => verify(fixture.plan),
      installDesktopTextContextMenus: initialize,
    })
    await run()
    expect(initialize).not.toHaveBeenCalled()
    expect(fixture.normalRequest).not.toHaveBeenCalled()
  })
  it('unexpected isolated startup rejection exits without retrying the normal authentication path', () => {
    const fixture = verifiedFixture()
    const failure = evaluate(callback('catch').getText(syntax), fixture.globals)
    failure(new Error('Synthetic startup failure'))
    expect(fixture.app.exit).toHaveBeenCalledWith(1)
    expect(fixture.normalRequest).not.toHaveBeenCalled()
  })
  it('normal startup rejection retains the existing window recovery behavior', () => {
    const fixture = verifiedFixture()
    const failure = evaluate(callback('catch').getText(syntax), {
      ...fixture.globals,
      devIsolationPlan: null,
    })
    failure(new Error('Synthetic normal startup failure'))
    expect(fixture.app.exit).not.toHaveBeenCalled()
    expect(fixture.normalRequest).toHaveBeenCalledOnce()
  })
})
