import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC_ROOT = new URL('../src', import.meta.url).pathname
const FORBIDDEN = [
  'CLERUM_CONTROL_API',
  'controlApiUrl',
  'controlApiServiceName',
  'controlApiServiceToken',
  'nginx-workflow-approval-gateway',
  'workflow-approval-gateway',
  'x-service-token',
  '/api/v1/internal/notifications',
  '/api/v1/internal/workflow-approval-mediums',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('channel-reader control-api boundary', () => {
  it('keeps workflow approval delivery and verification behind mcp-host runtime APIs', () => {
    const haystack = sourceFiles(SRC_ROOT)
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')

    for (const needle of FORBIDDEN) {
      expect(haystack, `forbidden direct control-api dependency: ${needle}`).not.toContain(needle)
    }
  })
})
