import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

// A real-Postgres suite that ends a pg pool with a plain `.end()` and later runs
// pg_terminate_backend against the same database can reach a client that is
// still closing: pg-pool's end() resolves before each client's connection has
// closed, and the 57P01 the terminate sends that client is re-emitted on the
// pool as an unhandled error. Such a pool must be ended through
// endPoolAndWaitForClients. The only pool a suite may still end with a plain
// `.end()` is the one that runs the terminate: its own connection is excluded
// by `pid <> pg_backend_pid()` and nothing terminates it afterwards.
//
// The scan uses TypeScript's local bindings, without loading dependencies or
// following imports. It recognizes named pg Pool imports, typed/constructed
// local pools, aliases, and destructured methods. Formatting, computed 'end'
// access, and callback arguments do not change a pool's identity. HTTP/stream
// ends are outside this rule. It does not resolve dynamic receivers, factory
// returns without a Pool type, or cross-file/data-flow aliases. Terminate SQL
// must contain a literal pg_terminate_backend in a direct query call.
// The helper's retained error observer is proven behaviorally with a real pg
// Pool and its removed-client forwarding listener in the helper test suite.

const testDir = dirname(fileURLToPath(import.meta.url))
const REAL_POSTGRES_SUITE = /\.realPostgres.*\.test\.ts$/
type PoolBinding = ts.Symbol | ts.NewExpression

interface ScannedSuite {
  file: string
  terminators: string[]
  poolEnds: number
  terminateQueries: number
  parseErrors: string[]
  unresolvedTerminators: string[]
  violations: string[]
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression
  return expression
}

function memberReceiver(expression: ts.Expression, name: string): ts.Expression | undefined {
  expression = unwrap(expression)
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === name) {
    return expression.expression
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === name
  )
    return expression.expression
  return undefined
}

function scanSource(file: string, source: string): ScannedSuite {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const options: ts.CompilerOptions = { noLib: true, noResolve: true }
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options),
    getSourceFile: name => (name === file ? ast : undefined),
    readFile: name => (name === file ? source : undefined),
    fileExists: name => name === file,
  }
  const program = ts.createProgram([file], options, host)
  const checker = program.getTypeChecker()
  const importedPool = (node: ts.Node): boolean =>
    checker.getSymbolAtLocation(node)?.declarations?.some(declaration => {
      if (
        !ts.isImportSpecifier(declaration) ||
        (declaration.propertyName ?? declaration.name).text !== 'Pool'
      )
        return false
      const importedFrom = declaration.parent.parent.parent
      return (
        ts.isImportDeclaration(importedFrom) &&
        ts.isStringLiteral(importedFrom.moduleSpecifier) &&
        importedFrom.moduleSpecifier.text === 'pg'
      )
    }) ?? false
  const poolType = (type: ts.TypeNode): boolean =>
    ts.isTypeReferenceNode(type)
      ? importedPool(type.typeName)
      : ts.isUnionTypeNode(type) && type.types.some(poolType)

  function poolBinding(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>()
  ): PoolBinding | undefined {
    expression = unwrap(expression)
    if (ts.isNewExpression(expression) && importedPool(expression.expression)) return expression
    if (!ts.isIdentifier(expression)) return undefined
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol)) return undefined
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration)))
      return undefined
    if (declaration.initializer) {
      const initial = unwrap(declaration.initializer)
      if (ts.isNewExpression(initial) && importedPool(initial.expression)) return symbol
      const alias = poolBinding(initial, seen)
      if (alias) return alias
    }
    return declaration.type && poolType(declaration.type) ? symbol : undefined
  }

  function methodPool(
    expression: ts.Expression,
    method: string,
    seen = new Set<ts.Symbol>()
  ): PoolBinding | undefined {
    expression = unwrap(expression)
    const receiver = memberReceiver(expression, method)
    if (receiver) return poolBinding(receiver)
    if (!ts.isIdentifier(expression)) return undefined
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol)) return undefined
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return methodPool(declaration.initializer, method, seen)
    }
    if (
      declaration &&
      ts.isBindingElement(declaration) &&
      ts.isObjectBindingPattern(declaration.parent)
    ) {
      const property = declaration.propertyName ?? declaration.name
      const variable = declaration.parent.parent
      if (
        (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) &&
        property.text === method &&
        ts.isVariableDeclaration(variable) &&
        variable.initializer
      )
        return poolBinding(variable.initializer)
    }
    return undefined
  }

  const calls: ts.CallExpression[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const location = (node: ts.Node): string =>
    `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`
  const bindingName = (binding: PoolBinding): string =>
    'getName' in binding ? binding.getName() : '(new Pool)'
  const terminationCalls = calls.filter(
    call =>
      memberReceiver(call.expression, 'query') &&
      call.arguments.some(arg =>
        ts.isStringLiteralLike(arg)
          ? arg.text.includes('pg_terminate_backend')
          : ts.isTemplateExpression(arg) &&
            [arg.head, ...arg.templateSpans.map(span => span.literal)].some(part =>
              part.text.includes('pg_terminate_backend')
            )
      )
  )
  const terminators = new Set<PoolBinding>()
  const unresolvedTerminators: string[] = []
  for (const call of terminationCalls) {
    const pool = methodPool(call.expression, 'query')
    if (pool) terminators.add(pool)
    else unresolvedTerminators.push(location(call))
  }
  const ends = calls.flatMap(call => {
    const pool = methodPool(call.expression, 'end')
    return pool ? [{ call, pool }] : []
  })
  return {
    file,
    terminators: [...terminators].map(bindingName),
    terminateQueries: terminationCalls.length,
    poolEnds: ends.length,
    parseErrors: program
      .getSyntacticDiagnostics(ast)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    unresolvedTerminators,
    violations: ends
      .filter(({ pool }) => !terminators.has(pool))
      .map(({ call, pool }) => `${location(call)} ${bindingName(pool)}.end()`),
  }
}

function scanSuites(): ScannedSuite[] {
  return readdirSync(testDir)
    .filter(file => REAL_POSTGRES_SUITE.test(file))
    .sort()
    .flatMap(file => {
      const source = readFileSync(join(testDir, file), 'utf8')
      const suite = scanSource(file, source)
      return suite.terminateQueries > 0 || suite.parseErrors.length > 0 ? [suite] : []
    })
}

describe('real-Postgres teardown guard', () => {
  it('ends every pool other than the terminating one through endPoolAndWaitForClients', () => {
    const suites = scanSuites()

    // Witnesses: the scan reached suites that terminate backends, in each one
    // it identified the pool that runs the terminate, and it matched plain
    // `.end()` calls at all (the terminating pools' own). Without them, an
    // empty violation list would say nothing.
    expect(suites.length).toBeGreaterThan(0)
    expect(suites.filter(suite => suite.terminators.length === 0).map(suite => suite.file)).toEqual(
      []
    )
    expect(suites.flatMap(suite => suite.parseErrors)).toEqual([])
    expect(suites.flatMap(suite => suite.unresolvedTerminators)).toEqual([])
    expect(suites.reduce((sum, suite) => sum + suite.poolEnds, 0)).toBeGreaterThan(0)

    expect(suites.flatMap(suite => suite.violations)).toEqual([])
  })

  it('reports optional-chained, cast and chained ends, and allows the terminating pool', () => {
    const source = [
      "import { Pool } from 'pg'",
      'let adminPool: Pool, dbPool: Pool, pool: Pool, corePool: Pool',
      'await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity`)',
      'await dbPool.end()',
      'await pool?.end()',
      'await (dbPool as Pool).end()',
      'await corePool?.end().catch(() => undefined)',
      'await adminPool?.end()',
      'await adminPool.end()',
    ].join('\n')

    const suite = scanSource('fixture.realPostgres.test.ts', source)

    // Witness: the terminate query named the pool that is allowed a plain end.
    expect(suite.terminators).toEqual(['adminPool'])
    expect(suite.violations).toEqual([
      'fixture.realPostgres.test.ts:4 dbPool.end()',
      'fixture.realPostgres.test.ts:5 pool.end()',
      'fixture.realPostgres.test.ts:6 dbPool.end()',
      'fixture.realPostgres.test.ts:7 corePool.end()',
    ])
  })

  it.each([
    ['a split receiver', 'await appPool\n  .end()'],
    ['split arguments', 'await appPool.end(\n)'],
    ['a computed method', "await appPool['end']()"],
    ['a callback', 'appPool.end(() => {})'],
    ['an optional callback', 'appPool?.end(() => {})'],
    ['a destructured method', 'const { end } = appPool; end()'],
    ['a renamed destructured method', 'const { end: close } = appPool; close()'],
    ['a method alias', 'const close = appPool.end; close()'],
    ['a shadowed administrative name', '{ const adminPool = appPool; await adminPool.end() }'],
  ])('rejects a pool end through %s', (_name, end) => {
    const source = [
      "import { Pool } from 'pg'",
      'let adminPool: Pool',
      'let appPool: Pool',
      'await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity`)',
      end,
    ].join('\n')

    expect(scanSource('fixture.realPostgres.test.ts', source).violations).toHaveLength(1)
  })

  it('allows aliases of the terminating pool and real HTTP request ends', () => {
    const source = [
      "import { Pool as PgPool } from 'pg'",
      "import * as http from 'node:http'",
      'const terminator = new PgPool()',
      'await terminator\n  .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity`)',
      'const administrativeAlias = terminator',
      'await administrativeAlias.end(() => {})',
      'const req = http.request({})',
      'req.end()',
      "req['end']('body')",
      'req.end(() => {})',
    ].join('\n')

    const suite = scanSource('fixture.realPostgres.test.ts', source)
    expect(suite.parseErrors).toEqual([])
    expect(suite.terminators).toEqual(['terminator'])
    expect(suite.poolEnds).toBe(1)
    expect(suite.violations).toEqual([])
  })

  it('reports parse errors and an unresolved terminating receiver instead of passing vacuously', () => {
    const invalid = scanSource('fixture.realPostgres.test.ts', 'const pool = new Pool(')
    expect(invalid.parseErrors.length).toBeGreaterThan(0)
    const unresolved = scanSource(
      'fixture.realPostgres.test.ts',
      'pool.query(`SELECT pg_terminate_backend(pid)`)'
    )
    expect(unresolved.terminateQueries).toBe(1)
    expect(unresolved.unresolvedTerminators).toEqual(['fixture.realPostgres.test.ts:1'])
    expect(unresolved.terminators).toEqual([])
  })
})
