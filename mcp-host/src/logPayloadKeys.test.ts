import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { redactUnknown } from './logger'

// A log field whose key the logger redacts reaches the emitted line as
// "[Redacted]", so a count such as `contextWindowTokens` is lost (#803). This
// scans every log call in src and rejects object-literal keys that
// `redactUnknown` would replace. Spread and variable payloads are not resolved.

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'log'])

type KeyUse = { file: string; line: number; key: string }

function isRedactedKey(key: string): boolean {
  return (redactUnknown({ [key]: 1 }) as Record<string, unknown>)[key] === '[Redacted]'
}

function redactedLogKeys(file: string, source: string): { calls: number; hits: KeyUse[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let calls = 0
  const hits: KeyUse[] = []
  const visitObject = (obj: ts.ObjectLiteralExpression): void => {
    for (const prop of obj.properties) {
      const name = ts.isSpreadAssignment(prop) ? undefined : prop.name
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && isRedactedKey(name.text)) {
        const line = sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1
        hits.push({ file, line, key: name.text })
      }
      if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        visitObject(prop.initializer)
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOG_METHODS.has(node.expression.name.text)
    ) {
      calls += 1
      for (const arg of node.arguments) {
        if (ts.isObjectLiteralExpression(arg)) visitObject(arg)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, hits }
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
  it('detects redacted keys in a log payload, nested ones included', () => {
    const { calls, hits } = redactedLogKeys(
      'fixture.ts',
      [
        "logger.info({ event: 'x', contextWindowTokens: 1, nested: { refreshToken: 'r' } }, 'm')",
        "console.warn('[X] y', { ok: true, 'api-key': 'k' })",
        "logger.debug({ contextWindow: 1, source: 'catalog' }, 'clean')",
      ].join('\n')
    )
    expect(calls).toBe(3)
    expect(hits).toEqual([
      { file: 'fixture.ts', line: 1, key: 'contextWindowTokens' },
      { file: 'fixture.ts', line: 1, key: 'refreshToken' },
      { file: 'fixture.ts', line: 2, key: 'api-key' },
    ])
  })

  it('no log call in src passes a key the logger would redact', () => {
    const files = sourceFiles(__dirname)
    let calls = 0
    const hits: string[] = []
    for (const file of files) {
      const rel = path.relative(__dirname, file)
      const result = redactedLogKeys(rel, fs.readFileSync(file, 'utf8'))
      calls += result.calls
      hits.push(...result.hits.map(h => `${h.file}:${h.line} ${h.key}`))
    }
    // Witness: the scan read the real tree, so an empty result is not an empty scan.
    expect(files).toContain(path.join(__dirname, 'agent', 'taskExecutor.ts'))
    expect(files.length).toBeGreaterThan(200)
    expect(calls).toBeGreaterThan(400)
    expect(hits).toEqual([])
  })
})
