import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(__dirname, '..')

const GATED = new Set([
  'hostReconciler.ts',
  'reconciler.ts',
  'sharedFileSystemReconciler.ts',
  'llmHookReconciler.ts',
])

const EXEMPT = new Set(['k8s/gfsK8sApi.ts', 'statelessLifecycleExecutor.ts'])

/** Any call, including `replace(params)` — not only inline `({ ... })`. */
const CALL = /replaceNamespacedDeployment\s*\(/g

function productionTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry.endsWith('.test.ts')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...productionTsFiles(full))
      continue
    }
    if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index - 1) + 1
  const end = source.indexOf('\n', index)
  return source.slice(start, end === -1 ? source.length : end)
}

function callSiteIndexes(source: string): number[] {
  const indexes: number[] = []
  for (const match of source.matchAll(CALL)) {
    if (match.index === undefined) continue
    if (isCommentLine(lineAt(source, match.index))) continue
    indexes.push(match.index)
  }
  return indexes
}

function enclosingReplaceRetryBlock(source: string, callIndex: number): string | null {
  let searchFrom = 0
  let lastStart = -1
  while (true) {
    const idx = source.indexOf('replaceWithConflictRetry', searchFrom)
    if (idx === -1 || idx > callIndex) break
    lastStart = idx
    searchFrom = idx + 1
  }
  if (lastStart === -1) return null
  const paren = source.indexOf('(', lastStart)
  if (paren === -1 || paren > callIndex) return null
  let depth = 0
  for (let i = paren; i < source.length; i++) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) {
        if (i < callIndex) return null
        return source.slice(lastStart, i + 1)
      }
    }
  }
  return null
}

function isDeploymentGated(block: string): boolean {
  return /isUpToDate:/.test(block) && /deploymentMatchesDesired/.test(block)
}

describe('Deployment writer inventory', () => {
  it('every replaceNamespacedDeployment call is gated or explicitly exempt', () => {
    const hits: Array<{ rel: string; count: number; gated: boolean }> = []
    for (const file of productionTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll('\\', '/')
      const source = readFileSync(file, 'utf8')
      const sites = callSiteIndexes(source)
      if (sites.length === 0) continue
      const isGated = GATED.has(rel)
      const isExempt = EXEMPT.has(rel)
      expect(
        isGated || isExempt,
        `${rel} calls replaceNamespacedDeployment ${sites.length} time(s) but is on neither the gated nor the exempt list`
      ).toBe(true)

      for (const index of sites) {
        const block = enclosingReplaceRetryBlock(source, index)
        if (isGated) {
          expect(
            block,
            `${rel} call at index ${index} is not inside replaceWithConflictRetry`
          ).not.toBeNull()
          expect(
            isDeploymentGated(block ?? ''),
            `${rel} call at index ${index} is missing an isUpToDate deploymentMatchesDesired gate`
          ).toBe(true)
        }
        if (isExempt) {
          expect(
            block !== null && isDeploymentGated(block),
            `${rel} is exempt and must not wire the Deployment no-op gate`
          ).toBe(false)
        }
      }

      hits.push({ rel, count: sites.length, gated: isGated })
    }

    expect(hits.map(h => h.rel).sort()).toEqual([...GATED, ...EXEMPT].sort())
    expect(hits.reduce((sum, h) => sum + h.count, 0)).toBe(8)
    expect(
      hits
        .filter(h => h.gated)
        .map(h => h.rel)
        .sort()
    ).toEqual([...GATED].sort())
  })
})
