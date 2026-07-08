import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const FORBIDDEN_PRODUCTION_OVERRIDES = ['CONTROL_API_WORKFLOW_RECIPES_URL']

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
    } else if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

describe('security env override guardrails', () => {
  it('does not allow token-bearing WRC backend URL overrides in production code', () => {
    const offenders = listSourceFiles(SRC_DIR).flatMap(file => {
      const contents = readFileSync(file, 'utf8')
      return FORBIDDEN_PRODUCTION_OVERRIDES.flatMap(envName =>
        contents.includes(envName) ? [`${file}: ${envName}`] : []
      )
    })

    expect(offenders).toEqual([])
  })
})
