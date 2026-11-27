import { describe, expect, it } from 'vitest'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

// Every reader of the run DTO states who reads it: Control UI routes pass
// 'admin' (they see an operator cancel's subject), every other surface passes
// 'tenant' (it sees `operator`). The type checker only proves that a viewer is
// passed, not which one, so this test pins the viewer of every call site.
//
// It builds the control-api program from tsconfig.json and resolves each
// identifier through the type checker (aliases followed), so aliased and
// namespace imports are found and same-named unrelated functions are not.

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(packageDir, 'src')
const declarationFile = join(srcDir, 'services', 'workflows', 'workflowRunReadService.ts')

/** Position of the `viewer` argument of each reader. */
const VIEWER_ARGUMENT_INDEX: Record<string, number> = {
  mapDbRun: 1,
  listCanonicalRuns: 3,
  getLatestRun: 2,
  getWorkflowHealth: 2,
}

/** The call sites outside the declaring file: `file|viewer` -> number of calls. */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'routes/admin/workflows/runs.routes.ts|admin': 3,
  'routes/admin/workflows/trigger.routes.ts|admin': 1,
  'routes/admin/workflows/read.routes.ts|admin': 1,
  'routes/admin/workflows/cancel.routes.ts|admin': 1,
  'routes/admin/outputs.ts|admin': 1,
  'routes/external/decisions.routes.ts|tenant': 1,
  'routes/external/workflows/cancel.routes.ts|tenant': 1,
  'routes/external/workflows/resume.routes.ts|tenant': 1,
  'routes/external/workflows/trigger.routes.ts|tenant': 1,
  'routes/external/workflows/runs.routes.ts|tenant': 1,
  'routes/external/workflows/read.routes.ts|tenant': 1,
  'routes/mcp-host/workflows/read.routes.ts|tenant': 4,
  'routes/mcp-host/workflows/trigger.routes.ts|tenant': 1,
  'services/workflowApprovalProviderDecisionService.ts|tenant': 1,
}

function loadProgram(): ts.Program {
  const configPath = join(packageDir, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir)
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n')
    )
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
}

function isInside(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (predicate(current)) return true
  }
  return false
}

/** The call whose callee is `id` (`f(...)` or `ns.f(...)`), if any. */
function callOf(id: ts.Identifier): ts.CallExpression | null {
  const parent = id.parent
  if (ts.isCallExpression(parent) && parent.expression === id) return parent
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === id &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return parent.parent
  }
  return null
}

type Reference = { file: string; line: number; name: string; id: ts.Identifier }

function collectReferences(program: ts.Program, checker: ts.TypeChecker) {
  const declarationSource = program.getSourceFile(declarationFile)
  if (!declarationSource) throw new Error(`missing ${declarationFile} in the program`)
  const moduleSymbol = checker.getSymbolAtLocation(declarationSource)
  if (!moduleSymbol) throw new Error('workflowRunReadService has no module symbol')
  const targets = new Map<ts.Symbol, string>()
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    if (exported.getName() in VIEWER_ARGUMENT_INDEX) targets.set(exported, exported.getName())
  }
  expect([...targets.values()].sort()).toEqual(Object.keys(VIEWER_ARGUMENT_INDEX).sort())

  const references: Reference[] = []
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.fileName.startsWith(srcDir)) continue
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        const name = symbol ? targets.get(symbol) : undefined
        const isDeclarationName = ts.isFunctionDeclaration(node.parent) && node.parent.name === node
        if (name && !isDeclarationName) {
          references.push({
            file: relative(srcDir, source.fileName),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            name,
            id: node,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return references
}

describe('run DTO viewer call sites', () => {
  it('every reader passes its viewer', () => {
    const program = loadProgram()
    const checker = program.getTypeChecker()
    const references = collectReferences(program, checker)
    const declarationRelative = relative(srcDir, declarationFile)

    const nonCalls: string[] = []
    const external = new Map<string, number>()
    const externalWrongViewer: string[] = []
    let internalCalls = 0
    const internalWrongViewer: string[] = []

    for (const reference of references) {
      const where = `${reference.file}:${reference.line} ${reference.name}`
      if (isInside(reference.id, node => ts.isImportDeclaration(node))) continue
      if (isInside(reference.id, node => ts.isTypeQueryNode(node))) continue
      const call = callOf(reference.id)
      if (!call) {
        nonCalls.push(where)
        continue
      }
      const argument = call.arguments[VIEWER_ARGUMENT_INDEX[reference.name]!]
      if (reference.file === declarationRelative) {
        internalCalls += 1
        const symbol =
          argument && ts.isIdentifier(argument) ? checker.getSymbolAtLocation(argument) : undefined
        const declaration = symbol?.valueDeclaration
        const passesReceivedViewer =
          declaration !== undefined &&
          ts.isParameter(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'viewer'
        if (!passesReceivedViewer) internalWrongViewer.push(where)
        continue
      }
      if (
        !argument ||
        !ts.isStringLiteral(argument) ||
        (argument.text !== 'admin' && argument.text !== 'tenant')
      ) {
        externalWrongViewer.push(`${where}: ${argument ? argument.getText() : '<missing>'}`)
        continue
      }
      const key = `${reference.file}|${argument.text}`
      external.set(key, (external.get(key) ?? 0) + 1)
    }

    expect(nonCalls).toEqual([])
    expect(externalWrongViewer).toEqual([])
    expect(internalWrongViewer).toEqual([])
    expect(Object.fromEntries([...external].sort())).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_CALL_SITES).sort())
    )
    // Liveness witness: the scan found every listed call site, and the
    // declaring file's own readers were visited too.
    const found = [...external.values()].reduce((sum, count) => sum + count, 0)
    const listed = Object.values(EXPECTED_CALL_SITES).reduce((sum, count) => sum + count, 0)
    expect(found).toBe(listed)
    expect(found).toBeGreaterThan(0)
    expect(internalCalls).toBeGreaterThan(0)
  }, 120_000)
})
