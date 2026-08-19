import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('main window shortcut lifecycle', () => {
  it('owns host shortcut routing through BrowserWindow teardown', async () => {
    const source = await readFile(path.join(process.cwd(), 'src', 'main.ts'), 'utf8')

    expect(source).toContain('wireHostDesktopShortcutRouting(window)')
  })
})
