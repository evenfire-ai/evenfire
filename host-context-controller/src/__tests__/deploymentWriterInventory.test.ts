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

const CALL = /replaceNamespacedDeployment\s*\(\s*\{/g

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

describe('Deployment writer inventory', () => {
  it('every replaceNamespacedDeployment call is gated or explicitly exempt', () => {
    const hits: Array<{ rel: string; count: number; gated: boolean }> = []
    for (const file of productionTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll('\\', '/')
      const source = readFileSync(file, 'utf8')
      const count = source.match(CALL)?.length ?? 0
      if (count === 0) continue
      const isGated = GATED.has(rel)
      const isExempt = EXEMPT.has(rel)
      expect(
        isGated || isExempt,
        `${rel} calls replaceNamespacedDeployment ${count} time(s) but is on neither the gated nor the exempt list`
      ).toBe(true)
      if (isGated) {
        expect(
          source.includes('deploymentMatchesDesired'),
          `${rel} is gated but does not reference deploymentMatchesDesired`
        ).toBe(true)
      }
      if (isExempt) {
        expect(
          source.includes('isUpToDate: deploymentMatchesDesired'),
          `${rel} is exempt and must not wire the Deployment no-op gate`
        ).toBe(false)
      }
      hits.push({ rel, count, gated: isGated })
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
