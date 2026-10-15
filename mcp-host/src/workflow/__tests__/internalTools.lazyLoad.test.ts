// Importing the internal tools loads no document library: the host starts
// without them, and each loads the first time its generator runs.
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'
import * as path from 'path'

const LIBRARIES = [
  'docx',
  'exceljs',
  'pdfmake',
  'pptxgenjs',
  'chart.js',
  '@napi-rs/canvas',
  'jszip',
]

const imported = vi.hoisted(() => [] as string[])
vi.mock('docx', () => (imported.push('docx'), {}))
vi.mock('exceljs', () => (imported.push('exceljs'), {}))
vi.mock('pdfmake', () => (imported.push('pdfmake'), {}))
vi.mock('pptxgenjs', () => (imported.push('pptxgenjs'), {}))
vi.mock('chart.js', () => (imported.push('chart.js'), {}))
vi.mock('@napi-rs/canvas', () => (imported.push('@napi-rs/canvas'), {}))
vi.mock('jszip', () => (imported.push('jszip'), {}))

/** Libraries Node has loaded through require, which vi.mock does not see. */
function required(): string[] {
  const cache = createRequire(path.resolve('package.json')).cache
  return LIBRARIES.filter(lib =>
    Object.keys(cache).some(file => file.includes(`/node_modules/${lib}/`))
  )
}

describe('internal tools module', () => {
  it('loads no document library when imported', async () => {
    const before = required()
    const { INTERNAL_TOOLS } = await import('../internalTools')
    expect(INTERNAL_TOOLS.length).toBeGreaterThan(0)
    expect(imported).toEqual([])
    expect(required()).toEqual(before)
  })
})
