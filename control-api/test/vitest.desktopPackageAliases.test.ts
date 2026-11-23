import { expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

it('resolves the real Desktop links package from the repository checkout', async () => {
  const config = await import('../vitest.config.ts')
  const aliases = (config.default as { resolve?: { alias?: Record<string, string> } } | undefined)
    ?.resolve?.alias
  const packageEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../packages/desktop-app-links/index.cjs'
  )

  expect(aliases?.['@clerum/desktop-app-links']).toBe(packageEntry)
})
