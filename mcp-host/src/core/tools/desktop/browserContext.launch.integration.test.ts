import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { BrowserContextManager } from './browserContext'

// The temporary POSIX executable records Playwright's arguments and exits;
// no browser, display, remote page or external process is started.
describe.skipIf(process.platform === 'win32')('desktop browser launch arguments', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('omits the no-sandbox flag in the real Playwright launch path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'browser-sandbox-args-'))
    const executable = path.join(directory, 'browser-stub')
    const argumentsPath = path.join(directory, 'arguments')
    try {
      await writeFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$BROWSER_ARGUMENT_CAPTURE"\nexit 42\n',
        { mode: 0o700 }
      )
      await chmod(executable, 0o700)
      vi.stubEnv('BROWSER_ARGUMENT_CAPTURE', argumentsPath)

      // Negative control: an explicitly unsandboxed Playwright launch must
      // produce the flag that the protected desktop path is required to omit.
      await expect(
        chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: false })
      ).rejects.toThrow()
      expect((await readFile(argumentsPath, 'utf8')).split('\n')).toContain('--no-sandbox')

      vi.stubEnv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', executable)
      await expect(new BrowserContextManager().getPage()).rejects.toThrow()
      const args = (await readFile(argumentsPath, 'utf8')).split('\n')
      expect(args).not.toContain('--no-sandbox')
      expect(args).not.toContain('--disable-setuid-sandbox')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
