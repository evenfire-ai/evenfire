import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'

describe('desktop UI content security policy', () => {
  it('allows blob-backed media used by GFS video previews', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'ui', 'index.html'), 'utf8')
    const content = source.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]

    expect(content).toContain("media-src 'self' blob:")
  })
})
