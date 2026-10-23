// Production modules of the document tools stay under 1,000 lines, so a
// generator that grows is split by concern instead of becoming a hub again.
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const MAX_LINES = 1000
const ROOTS = ['../../workflow', '../../artifacts'].map(dir => path.resolve(__dirname, dir))
/** Older than this rule; not part of the document tools. */
const PREDATING = new Set(['workflow/workflowService.ts'])

function productionModules(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') found.push(...productionModules(file))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(file)
    }
  }
  return found
}

describe('document tool module size', () => {
  it(`keeps every production module at ${MAX_LINES} lines or fewer`, () => {
    const modules = ROOTS.flatMap(productionModules)
    const src = path.resolve(__dirname, '../..')
    // Witness: the walk finds the generators, so an empty list cannot pass.
    expect(modules.map(file => path.relative(src, file))).toEqual(
      expect.arrayContaining([
        'workflow/internalTools.ts',
        'workflow/pdfGenerator.ts',
        'artifacts/officePackageText.ts',
      ])
    )
    const over = modules
      .map(file => ({
        name: path.relative(src, file),
        lines: fs.readFileSync(file, 'utf8').split('\n').length - 1,
      }))
      .filter(m => m.lines > MAX_LINES && !PREDATING.has(m.name))
    expect(over).toEqual([])
  })
})
