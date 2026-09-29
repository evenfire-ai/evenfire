import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { redactUnknown } from './logger'

// A log field whose key the logger redacts reaches the emitted line as
// "[Redacted]", and a key outside SAFE_OBJECT_KEY is dropped from it, so a
// count such as `contextWindowTokens` is lost (#803). This scans
// .debug/.info/.warn/.error/.log calls in non-test files under src and rejects
// such keys in object-literal arguments, including nested objects, array
// items, `as`/`satisfies`/conditional wrappers and literal computed keys.
// Payloads passed as variables or spreads of variables are not resolved.

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'log'])

type KeyUse = { file: string; line: number; key: string }

function isLostKey(key: string): boolean {
  const out = redactUnknown({ [key]: 1 }) as Record<string, unknown>
  return !(key in out) || out[key] === '[Redacted]'
}

function literalKey(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text
  }
  return undefined
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function redactedLogKeys(
  file: string,
  source: string
): { calls: number; hits: KeyUse[]; visited: KeyUse[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let calls = 0
  const hits: KeyUse[] = []
  const visited: KeyUse[] = []
  const visitValue = (expr: ts.Expression): void => {
    const value = unwrap(expr)
    if (ts.isObjectLiteralExpression(value)) visitObject(value)
    else if (ts.isArrayLiteralExpression(value)) value.elements.forEach(visitValue)
    else if (ts.isConditionalExpression(value)) {
      visitValue(value.whenTrue)
      visitValue(value.whenFalse)
    }
  }
  const visitObject = (obj: ts.ObjectLiteralExpression): void => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        visitValue(prop.expression)
        continue
      }
      const key = prop.name && literalKey(prop.name)
      if (key !== undefined) {
        const use = {
          file,
          line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
          key,
        }
        visited.push(use)
        if (isLostKey(key)) hits.push(use)
      }
      if (ts.isPropertyAssignment(prop)) visitValue(prop.initializer)
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOG_METHODS.has(node.expression.name.text)
    ) {
      calls += 1
      node.arguments.forEach(visitValue)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, hits, visited }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourceFiles(full))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

describe('log payload keys survive redaction (#803)', () => {
  it('detects redacted and dropped keys in every payload shape it resolves', () => {
    const { calls, hits } = redactedLogKeys(
      'fixture.ts',
      [
        "logger.info({ event: 'x', contextWindowTokens: 1, nested: { refreshToken: 'r' } }, 'm')",
        "console.warn('[X] y', { ok: true, 'api-key': 'k' })",
        "logger.debug({ contextWindow: 1, source: 'catalog' }, 'clean')",
        "logger.info({ contextWindowTokens }, 'shorthand, the #803 shape')",
        "logger.info({ accessToken: 1 } as LogFields, 'as')",
        "logger.info(({ secret: 1 }) satisfies LogFields, 'parenthesized satisfies')",
        "logger.info(ok ? { password: 1 } : {}, 'conditional')",
        "logger.info({ items: [{ cookie: 1 }] }, 'array item')",
        "logger.info({ ['authorization']: 1, [`dsn`]: 2 }, 'computed')",
        "logger.info({ 'context window': 1 }, 'dropped by SAFE_OBJECT_KEY')",
      ].join('\n')
    )
    expect(calls).toBe(10)
    expect(hits.map(h => `${h.line} ${h.key}`)).toEqual([
      '1 contextWindowTokens',
      '1 refreshToken',
      '2 api-key',
      '4 contextWindowTokens',
      '5 accessToken',
      '6 secret',
      '7 password',
      '8 cookie',
      '9 authorization',
      '9 dsn',
      '10 context window',
    ])
  })

  it('no log call in src passes a key the logger would redact or drop', () => {
    const files = sourceFiles(__dirname)
    let calls = 0
    const hits: string[] = []
    const visited: KeyUse[] = []
    for (const file of files) {
      const rel = path.relative(__dirname, file)
      const result = redactedLogKeys(rel, fs.readFileSync(file, 'utf8'))
      calls += result.calls
      visited.push(...result.visited)
      hits.push(...result.hits.map(h => `${h.file}:${h.line} ${h.key}`))
    }
    // Witness: the scan read the real tree and reached the #803 call site, so
    // an empty result is not an empty scan.
    expect(files.length).toBeGreaterThan(200)
    expect(calls).toBeGreaterThan(400)
    expect(visited).toContainEqual(
      expect.objectContaining({ file: path.join('agent', 'taskExecutor.ts'), key: 'contextWindow' })
    )
    expect(hits).toEqual([])
  })
})
