import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const testDir = dirname(fileURLToPath(import.meta.url))
type PoolBinding = ts.Symbol | ts.NewExpression
type Callback = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration
interface Problem {
  file: string
  line: number
  reason: string
}
interface Audit {
  file: string
  hooks: number
  callbacks: number
  protectedCallbacks: number
  adminPools: number
  problems: Problem[]
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
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === name)
    return expression.expression
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === name
  )
    return expression.expression
  return undefined
}

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  function visit(child: ts.Node): void {
    found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function sqlPrefix(expression: ts.Expression): string {
  expression = unwrap(expression)
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isTemplateExpression(expression)) return expression.head.text
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return sqlPrefix(expression.left)
  }
  return ''
}

// This is a conservative local control-flow proof, not a receiver-name rule.
// Pools must come from pg constructors; admin identity comes from their bound
// CREATE/DROP DATABASE queries. A close must be awaited in a guaranteed outer
// finally, before anything there could fail, covering preceding cleanup.
// Unresolved imports, receivers, callbacks or equivalent flow fail explicitly.
// No dependency source, original module or database operation is executed.
function auditSource(file: string, source: string): Audit {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const options: ts.CompilerOptions = { noLib: true, noResolve: true }
  const program = ts.createProgram([file], options, {
    ...ts.createCompilerHost(options),
    getSourceFile: name => (name === file ? ast : undefined),
    readFile: name => (name === file ? source : undefined),
    fileExists: name => name === file,
  })
  const checker = program.getTypeChecker()
  const nodes = descendants(ast)
  const problems: Problem[] = []
  const problem = (node: ts.Node, reason: string): void => {
    problems.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      reason,
    })
  }
  for (const diagnostic of program.getSyntacticDiagnostics(ast)) {
    problems.push({
      file,
      line: ast.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      reason: `PARSE: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    })
  }
  const writes = new Map<ts.Symbol, number>()
  function recordWrite(identifier: ts.Identifier): void {
    const symbol = checker.getSymbolAtLocation(identifier)
    if (symbol) writes.set(symbol, (writes.get(symbol) ?? 0) + 1)
  }
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      recordWrite(node.name)
    if (ts.isFunctionDeclaration(node) && node.name) recordWrite(node.name)
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      recordWrite(node.left)
  }
  function imported(
    expression: ts.Expression,
    module: string,
    name: string,
    seen = new Set<ts.Symbol>()
  ): boolean {
    expression = unwrap(expression)
    if (!ts.isIdentifier(expression)) return false
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol) || (writes.get(symbol) ?? 0) > 1) return false
    seen.add(symbol)
    return (
      symbol.declarations?.some(declaration => {
        if (ts.isImportSpecifier(declaration)) {
          if ((writes.get(symbol) ?? 0) !== 0) return false
          const origin = declaration.parent.parent.parent
          return (
            (declaration.propertyName ?? declaration.name).text === name &&
            ts.isImportDeclaration(origin) &&
            ts.isStringLiteral(origin.moduleSpecifier) &&
            origin.moduleSpecifier.text === module
          )
        }
        return (
          ts.isVariableDeclaration(declaration) &&
          !!declaration.initializer &&
          imported(declaration.initializer, module, name, seen)
        )
      }) ?? false
    )
  }
  const isPoolCreation = (expression: ts.Expression): expression is ts.NewExpression => {
    expression = unwrap(expression)
    return ts.isNewExpression(expression) && imported(expression.expression, 'pg', 'Pool')
  }
  const constructed = new Set<ts.Symbol>()
  const creationSite = new Map<ts.Symbol, ts.Node>()
  let currentCallback: Callback | undefined
  function enclosingFunction(node: ts.Node): Callback | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isArrowFunction(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isFunctionDeclaration(parent)
      )
        return parent
    }
    return undefined
  }
  for (const node of nodes) {
    let identifier: ts.Identifier | undefined
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isPoolCreation(node.initializer)
    )
      identifier = node.name
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isPoolCreation(node.right)
    )
      identifier = node.left
    if (identifier) {
      const symbol = checker.getSymbolAtLocation(identifier)
      if (symbol) {
        constructed.add(symbol)
        creationSite.set(symbol, node)
      }
    }
  }
  for (const symbol of constructed) if (writes.get(symbol) !== 1) constructed.delete(symbol)
  function poolBinding(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>()
  ): PoolBinding | undefined {
    expression = unwrap(expression)
    if (isPoolCreation(expression)) return expression
    if (!ts.isIdentifier(expression)) return undefined
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol)) return undefined
    if ((writes.get(symbol) ?? 0) > 1) return undefined
    if (constructed.has(symbol)) return symbol
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
      return undefined
    const alias = poolBinding(declaration.initializer, seen)
    if (!alias || !('getName' in alias)) return alias
    const created = creationSite.get(alias)
    const scope = enclosingFunction(declaration)
    // A top-level alias cannot capture a mutable pool that is assigned only
    // when beforeAll runs. Aliases inside the actual cleanup callback, or
    // after construction in the same executing scope, are resolvable.
    return created &&
      ((scope === enclosingFunction(created) && declaration.pos > created.pos) ||
        (ts.isVariableDeclaration(created) && declaration.pos > created.pos) ||
        (currentCallback &&
          scope === currentCallback &&
          beforeAllScopes.has(enclosingFunction(created)!)))
      ? alias
      : undefined
  }
  const calls = nodes.filter(ts.isCallExpression)
  const beforeAllScopes = new Set<Callback>()
  for (const call of calls) {
    if (!imported(call.expression, 'vitest', 'beforeAll') || !call.arguments[0]) continue
    const setup = callback(call.arguments[0])
    if (setup) beforeAllScopes.add(setup)
  }
  const administrative = new Set<PoolBinding>()
  const administrativeOrigin = new Map<PoolBinding, ts.Node>()
  function resolvedSqlPrefix(expression: ts.Expression, seen = new Set<ts.Symbol>()): string {
    expression = unwrap(expression)
    if (!ts.isIdentifier(expression)) return sqlPrefix(expression)
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol) || writes.get(symbol) !== 1) return ''
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
      ? resolvedSqlPrefix(declaration.initializer, seen)
      : ''
  }
  for (const call of calls) {
    const receiver = memberReceiver(call.expression, 'query')
    if (
      !receiver ||
      !call.arguments[0] ||
      !/^\s*(?:CREATE|DROP)\s+DATABASE\b/i.test(resolvedSqlPrefix(call.arguments[0]))
    )
      continue
    const pool = poolBinding(receiver)
    if (pool) {
      administrative.add(pool)
      administrativeOrigin.set(pool, call)
    } else problem(call, 'UNRESOLVED administrative query receiver')
  }
  function callback(expression: ts.Expression, seen = new Set<ts.Symbol>()): Callback | undefined {
    expression = unwrap(expression)
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression
    if (!ts.isIdentifier(expression)) return undefined
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol) || (writes.get(symbol) ?? 0) > 1) return undefined
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration
    return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? callback(declaration.initializer, seen)
      : undefined
  }
  const isEnd = (call: ts.CallExpression, pool: PoolBinding): boolean => {
    const receiver = memberReceiver(call.expression, 'end')
    return !!receiver && poolBinding(receiver) === pool
  }
  function startsWithClose(expression: ts.Expression, pool: PoolBinding): boolean {
    expression = unwrap(expression)
    if (!ts.isCallExpression(expression)) return false
    if (isEnd(expression, pool)) return expression.arguments.length === 0
    // pg Pool.end is invoked before a recovery chain such as .catch(...)
    // evaluates its arguments. Recovery does not bypass the administrative
    // close; it preserves the fixture's existing error-handling semantics.
    const receiver = memberReceiver(expression.expression, 'catch')
    return !!receiver && startsWithClose(receiver, pool)
  }
  for (const node of nodes) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      continue
    const receiver = memberReceiver(node.left, 'end')
    const pool = receiver && poolBinding(receiver)
    if (pool && administrative.has(pool))
      problem(node, 'UNRESOLVED administrative end method reassignment')
  }
  const contains = (container: ts.Node, node: ts.Node): boolean =>
    container.pos <= node.pos && container.end >= node.end
  function unshadowedUndefined(expression: ts.Expression): boolean {
    expression = unwrap(expression)
    return (
      ts.isIdentifier(expression) &&
      expression.text === 'undefined' &&
      !checker.getSymbolAtLocation(expression)?.declarations?.length
    )
  }
  function presentWhenPoolExists(expression: ts.Expression, pool: PoolBinding): boolean {
    expression = unwrap(expression)
    if (poolBinding(expression) === pool) return true
    return (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) &&
      poolBinding(expression.left) === pool &&
      (expression.right.kind === ts.SyntaxKind.NullKeyword || unshadowedUndefined(expression.right))
    )
  }
  function pureExpression(expression: ts.Expression): boolean {
    expression = unwrap(expression)
    if (
      ts.isStringLiteralLike(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrowFunction(expression) ||
      ts.isFunctionExpression(expression)
    )
      return true
    if (ts.isIdentifier(expression)) {
      if (unshadowedUndefined(expression)) return true
      const symbol = checker.getSymbolAtLocation(expression)
      if (!symbol?.declarations?.length) return false
      return symbol.declarations.every(
        declaration =>
          !ts.isVariableDeclaration(declaration) ||
          enclosingFunction(declaration) !== currentCallback ||
          declaration.pos < expression.pos
      )
    }
    if (ts.isArrayLiteralExpression(expression))
      return expression.elements.every(
        element => !ts.isSpreadElement(element) && pureExpression(element)
      )
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.every(property => {
        if (ts.isSpreadAssignment(property)) return false
        if (property.name && ts.isComputedPropertyName(property.name)) {
          const key = unwrap(property.name.expression)
          if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) return false
        }
        if (ts.isPropertyAssignment(property)) return pureExpression(property.initializer)
        if (ts.isShorthandPropertyAssignment(property)) return pureExpression(property.name)
        return (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        )
      })
    }
    return false
  }
  function safePrefix(statement: ts.Statement): boolean {
    if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) return true
    if (ts.isBlock(statement)) return statement.statements.every(safePrefix)
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.every(
        declaration =>
          ts.isIdentifier(declaration.name) &&
          (!declaration.initializer || pureExpression(declaration.initializer))
      )
    if (ts.isExpressionStatement(statement)) return pureExpression(statement.expression)
    if (ts.isIfStatement(statement)) {
      const condition = unwrap(statement.expression)
      if (condition.kind === ts.SyntaxKind.FalseKeyword)
        return !statement.elseStatement || safePrefix(statement.elseStatement)
      if (condition.kind === ts.SyntaxKind.TrueKeyword) return safePrefix(statement.thenStatement)
    }
    return false
  }
  function safeWhenAbsent(expression: ts.Expression, pool: PoolBinding): boolean {
    expression = unwrap(expression)
    if (!ts.isCallExpression(expression)) return false
    if (isEnd(expression, pool)) {
      const member = expression.expression
      if (
        (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
        member.questionDotToken
      )
        return true
      const created = 'getName' in pool ? creationSite.get(pool) : pool
      return !!created && (ts.isNewExpression(created) || ts.isVariableDeclaration(created))
    }
    const receiver = memberReceiver(expression.expression, 'catch')
    return !!receiver && safeWhenAbsent(receiver, pool)
  }
  function guaranteedClose(
    statement: ts.Statement,
    pool: PoolBinding,
    knownPresent = false
  ): boolean {
    if (ts.isBlock(statement)) return guaranteedSequence(statement.statements, pool, knownPresent)
    if (ts.isIfStatement(statement) && presentWhenPoolExists(statement.expression, pool))
      return guaranteedClose(statement.thenStatement, pool, true)
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression))
      return false
    const expression = unwrap(statement.expression.expression)
    return startsWithClose(expression, pool) && (knownPresent || safeWhenAbsent(expression, pool))
  }
  function guaranteedSequence(
    statements: ts.NodeArray<ts.Statement>,
    pool: PoolBinding,
    knownPresent = false
  ): boolean {
    for (const statement of statements) {
      if (ts.isEmptyStatement(statement)) continue
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.every(
          declaration =>
            declaration.initializer &&
            ts.isIdentifier(unwrap(declaration.initializer)) &&
            poolBinding(declaration.initializer) === pool
        )
      )
        continue
      return guaranteedClose(statement, pool, knownPresent)
    }
    return false
  }
  let hooks = 0
  let callbacks = 0
  let protectedCallbacks = 0
  let adminPools = 0
  const closedByCallbacks = new Map<PoolBinding, number>()
  for (const call of calls) {
    const registered = imported(call.expression, 'vitest', 'afterAll')
    const apparent = ts.isIdentifier(call.expression) && call.expression.text === 'afterAll'
    if (!registered && !apparent) continue
    hooks += 1
    if (!registered) {
      problem(call, 'UNRESOLVED afterAll registration')
      continue
    }
    const cleanup = call.arguments[0] && callback(call.arguments[0])
    if (!cleanup || !cleanup.body || !ts.isBlock(cleanup.body)) {
      problem(call, 'UNRESOLVED afterAll callback')
      continue
    }
    callbacks += 1
    const callbackProblemsBefore = problems.length
    if (
      cleanup.parameters.some(
        parameter => !ts.isIdentifier(parameter.name) || parameter.initializer
      )
    ) {
      problem(call, 'UNPROVEN callback parameter evaluation before cleanup')
    }
    currentCallback = cleanup
    const body = cleanup.body
    const localNodes: ts.Node[] = []
    function visitCleanup(node: ts.Node): void {
      if (node !== body && ts.isFunctionLike(node)) return
      localNodes.push(node)
      ts.forEachChild(node, visitCleanup)
    }
    visitCleanup(body)
    const subjects = new Set<PoolBinding>()
    for (const node of localNodes) {
      if (!ts.isIdentifier(node)) continue
      const pool = poolBinding(node)
      if (pool && administrative.has(pool)) subjects.add(pool)
    }
    if (subjects.size === 0) {
      problem(call, 'UNRESOLVED administrative pool identity')
      continue
    }
    adminPools += subjects.size
    for (const pool of subjects) {
      const poolProblemsBefore = problems.length
      const ends = localNodes.filter(ts.isCallExpression).filter(end => isEnd(end, pool))
      if (ends.length !== 1) {
        problem(call, `Expected one administrative close, found ${ends.length}`)
        continue
      }
      const outer = body.statements.find(
        statement =>
          ts.isTryStatement(statement) &&
          statement.finallyBlock &&
          guaranteedSequence(statement.finallyBlock.statements, pool)
      )
      if (!outer || !ts.isTryStatement(outer) || !outer.finallyBlock) {
        problem(call, 'No guaranteed administrative close in an outer finally')
        continue
      }
      const unprotected = localNodes
        .filter(ts.isAwaitExpression)
        .filter(
          awaited =>
            !contains(outer.tryBlock, awaited) &&
            !(outer.catchClause && contains(outer.catchClause, awaited)) &&
            !(contains(outer.finallyBlock!, awaited) && contains(awaited, ends[0]!))
        )
      for (const awaited of unprotected)
        problem(awaited, 'Async cleanup is outside the administrative close guarantee')
      const before = body.statements.slice(0, body.statements.indexOf(outer))
      if (before.some(statement => !safePrefix(statement))) {
        problem(
          call,
          'UNPROVEN potentially throwing statement before the outer cleanup try/finally'
        )
      }
      if (problems.length === poolProblemsBefore)
        closedByCallbacks.set(pool, (closedByCallbacks.get(pool) ?? 0) + 1)
    }
    if (problems.length === callbackProblemsBefore) protectedCallbacks += 1
  }
  if (administrative.size > 0 && hooks === 0)
    problem(ast, 'Administrative pool fixture has no resolved afterAll callback')
  if (constructed.size > 0 && administrative.size === 0)
    problem(ast, 'UNRESOLVED administrative cleanup for constructed pg pools')
  for (const pool of administrative) {
    const closures = closedByCallbacks.get(pool) ?? 0
    if (closures !== 1)
      problem(
        administrativeOrigin.get(pool)!,
        `Expected one globally guaranteed administrative callback close, found ${closures}`
      )
  }
  return { file, hooks, callbacks, protectedCallbacks, adminPools, problems }
}

function discoverSuites(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory()
        ? discoverSuites(path)
        : entry.isFile() &&
            entry.name.includes('realPostgres') &&
            entry.name.endsWith('.integration.test.ts')
          ? [path]
          : []
    })
    .sort()
}

function fixture(body: string): string {
  return [
    "import { afterAll as teardown, beforeAll } from 'vitest'",
    "import { Pool as PgPool } from 'pg'",
    'const administrative = new PgPool()',
    'const appPool = new PgPool()',
    'beforeAll(async () => { await administrative.query(`CREATE DATABASE fixture`) })',
    'const owner = administrative',
    `teardown(async () => { ${body} })`,
  ].join('\n')
}

describe('real PostgreSQL administrative cleanup guard', () => {
  it('proves administrative closure for every physically discovered real-PG afterAll callback', () => {
    const files = discoverSuites(testDir)
    const audits = files.map(path =>
      auditSource(relative(testDir, path), readFileSync(path, 'utf8'))
    )
    // Reviewed inventory at 0a895015: 64 physical integrations / 65 hooks.
    // New suites are discovered automatically; deliberate removals require
    // explicit review of this lower-bound witness instead of silently passing.
    expect(files.length).toBeGreaterThanOrEqual(64)
    expect(new Set(files).size).toBe(files.length)
    expect(audits.flatMap(audit => audit.problems)).toEqual([])
    expect(audits.reduce((sum, audit) => sum + audit.hooks, 0)).toBeGreaterThanOrEqual(65)
    expect(audits.reduce((sum, audit) => sum + audit.callbacks, 0)).toBe(
      audits.reduce((sum, audit) => sum + audit.hooks, 0)
    )
    expect(
      audits
        .filter(audit => audit.callbacks > 0)
        .every(audit => audit.adminPools >= audit.callbacks)
    ).toBe(true)
    expect(audits.reduce((sum, audit) => sum + audit.protectedCallbacks, 0)).toBe(
      audits.reduce((sum, audit) => sum + audit.callbacks, 0)
    )
  })

  it.each([
    'try { await appPool.query(`SELECT 1`) } finally { await administrative?.end() }',
    "try { await appPool.query(`SELECT 1`) } finally { await (owner as PgPool)?.['end']() }",
    'try { await appPool.query(`SELECT 1`) } finally { if (owner) await owner.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { const closing = owner; await closing?.end() }',
    'const request = { end() {} }; try { request.end(); await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { await administrative?.end().catch(() => undefined) }',
    'try { await appPool.query(`SELECT 1`) } catch (error) { await appPool.query(`SELECT 2`); throw error } finally { await administrative.end() }',
    'if (false) { const previous = 1 } try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
  ])('accepts a provably safe binding and close: %s', body => {
    const audit = auditSource('fixture.realPostgres.test.ts', fixture(body))
    expect(audit.callbacks).toBe(1)
    expect(audit.adminPools).toBe(1)
    expect(audit.problems).toEqual([])
  })

  it.each([
    'await appPool.query(`SELECT 1`); await administrative.end()',
    'await appPool.query(`SELECT 1`); try {} finally { await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { if (false) await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { await appPool.query(`SELECT 2`); await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { const administrative = appPool; await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { const request = { end() {} }; request.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { const { end } = administrative; await end() }',
    'try { await appPool.query(`SELECT 1`) } finally { administrative.end() }',
    'if (true) return; try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'administrative = appPool; try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'administrative.end = async () => {}; try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'try { await appPool.query(`SELECT 1`) } finally { await appPool.query(`SELECT 2`).catch(() => administrative.end()) }',
    'beforeThatCanThrow(); try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'const value = sourceWithGetter.property; try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'prepareCleanup(sourceWithGetter.property); try { await appPool.query(`SELECT 1`) } finally { await administrative.end() }',
    'const undefined = owner; try { await appPool.query(`SELECT 1`) } finally { if (owner !== undefined) await owner.end() }',
  ])('rejects an unproven or unrelated administrative close: %s', body => {
    expect(
      auditSource('fixture.realPostgres.test.ts', fixture(body)).problems.length
    ).toBeGreaterThan(0)
  })

  it('fails on parse errors, unknown pool construction and unresolved callback references', () => {
    expect(
      auditSource('fixture.realPostgres.test.ts', 'const broken = (').problems.length
    ).toBeGreaterThan(0)
    expect(
      auditSource(
        'fixture.realPostgres.test.ts',
        fixture('try {} finally { await administrative.end() }').replace(
          'new PgPool()',
          'makePool()'
        )
      ).problems.length
    ).toBeGreaterThan(0)
    expect(
      auditSource(
        'fixture.realPostgres.test.ts',
        fixture('try {} finally { await administrative.end() }').replace(
          'teardown(async () => {',
          'teardown(unknownCallback); void (async () => {'
        )
      ).problems.length
    ).toBeGreaterThan(0)
  })

  it('rejects premature mutable aliases and unsafe absence handling while accepting cleanup-local aliases', () => {
    const prefix = [
      "import { afterAll, beforeAll } from 'vitest'",
      "import { Pool } from 'pg'",
      'let administrative: Pool',
      'beforeAll(async () => { administrative = new Pool(); await administrative.query(`CREATE DATABASE fixture`) })',
    ].join('\n')
    const early = `${prefix}\nconst owner = administrative\nafterAll(async () => { try { await administrative.query(\`DROP DATABASE fixture\`) } finally { await owner?.end() } })`
    expect(auditSource('fixture.realPostgres.test.ts', early).problems.length).toBeGreaterThan(0)
    const absent = `${prefix}\nafterAll(async () => { try { await administrative.query(\`DROP DATABASE fixture\`) } finally { await administrative.end() } })`
    expect(auditSource('fixture.realPostgres.test.ts', absent).problems.length).toBeGreaterThan(0)
    const local = `${prefix}\nafterAll(async () => { const owner = administrative; try { await administrative.query(\`DROP DATABASE fixture\`) } finally { await owner?.end() } })`
    expect(auditSource('fixture.realPostgres.test.ts', local).problems).toEqual([])
    const late = [
      "import { afterAll } from 'vitest'",
      "import { Pool } from 'pg'",
      'let administrative: Pool',
      'afterAll(async () => { const owner = administrative; administrative = new Pool(); try { await administrative.query(`DROP DATABASE fixture`) } finally { await owner?.end() } })',
    ].join('\n')
    expect(auditSource('fixture.realPostgres.test.ts', late).problems.length).toBeGreaterThan(0)
  })

  it.each([
    [
      'end argument evaluation',
      fixture(
        'try { await appPool.query(`SELECT 1`) } finally { await administrative.end(beforeCloseThatThrows()) }'
      ),
    ],
    [
      'omitted second administrative pool',
      [
        "import { afterAll, beforeAll } from 'vitest'",
        "import { Pool } from 'pg'",
        'const administrative = new Pool(); const forgotten = new Pool()',
        'beforeAll(async () => { await administrative.query(`CREATE DATABASE fixture`); await forgotten.query(`CREATE DATABASE other_fixture`) })',
        'afterAll(async () => { try { await administrative.query(`DROP DATABASE fixture`) } finally { await administrative.end() } })',
      ].join('\n'),
    ],
    [
      'SQL constant without a cleanup hook',
      [
        "import { Pool } from 'pg'",
        'const administrative = new Pool()',
        "const sql = 'DROP DATABASE fixture'",
        'administrative.query(sql)',
      ].join('\n'),
    ],
    [
      'reassigned callback',
      [
        "import { afterAll, beforeAll } from 'vitest'",
        "import { Pool } from 'pg'",
        'const administrative = new Pool()',
        'beforeAll(async () => { await administrative.query(`CREATE DATABASE fixture`) })',
        'let cleanup = async () => { try { await administrative.query(`DROP DATABASE fixture`) } finally { await administrative.end() } }',
        'cleanup = async () => {}',
        'afterAll(cleanup)',
      ].join('\n'),
    ],
    [
      'reassigned hook alias',
      [
        "import { afterAll, beforeAll } from 'vitest'",
        "import { Pool } from 'pg'",
        'const administrative = new Pool()',
        'beforeAll(async () => { await administrative.query(`CREATE DATABASE fixture`) })',
        'let register = afterAll',
        'register = (_callback: unknown) => {}',
        'register(async () => { try { await administrative.query(`DROP DATABASE fixture`) } finally { await administrative.end() } })',
      ].join('\n'),
    ],
    [
      'reassigned named function callback',
      [
        "import { afterAll, beforeAll } from 'vitest'",
        "import { Pool } from 'pg'",
        'const administrative = new Pool()',
        'beforeAll(async () => { await administrative.query(`CREATE DATABASE fixture`) })',
        'async function cleanup() { try { await administrative.query(`DROP DATABASE fixture`) } finally { await administrative.end() } }',
        'cleanup = async () => {}',
        'afterAll(cleanup)',
      ].join('\n'),
    ],
  ])('rejects reviewed unsafe shape: %s', (_name, source) => {
    expect(
      auditSource('fixture.realPostgres.integration.test.ts', source).problems.length
    ).toBeGreaterThan(0)
  })

  it('resolves immutable administrative SQL and stable named callback aliases', () => {
    const source = [
      "import { afterAll as register, beforeAll } from 'vitest'",
      "import { Pool } from 'pg'",
      'const administrative = new Pool()',
      "const createSql = 'CREATE DATABASE fixture'",
      "const dropSql = 'DROP DATABASE fixture'",
      'beforeAll(async () => { await administrative.query(createSql) })',
      'const cleanup = async () => { try { await administrative.query(dropSql) } finally { await administrative.end() } }',
      'register(cleanup)',
    ].join('\n')
    const audit = auditSource('fixture.realPostgres.integration.test.ts', source)
    expect(audit.callbacks).toBe(1)
    expect(audit.adminPools).toBe(1)
    expect(audit.protectedCallbacks).toBe(1)
    expect(audit.problems).toEqual([])
  })
})
