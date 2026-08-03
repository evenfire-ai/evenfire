// desktop-app/test/e2e-playwright/playwright.config.ts
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/** Load a dotenv-style file without overwriting an explicit process value. */
function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

/**
 * Resolve the canonical repository .env for a secondary worktree. Direct
 * Playwright invocations do not inherit the shell wrapper's environment, so
 * the Desktop lane must use the same root-env contract as Control UI:
 * explicit process values, then the canonical root .env, then test defaults.
 */
function loadCanonicalRootEnv(): void {
  // __dirname is desktop-app/test/e2e-playwright; walk to the worktree root.
  // This matters when Playwright is launched directly from a secondary
  // worktree: the canonical .env lives in the primary Evenfire checkout.
  const repoRoot = path.resolve(__dirname, '../../..')
  const localEnv = path.join(repoRoot, '.env')
  if (fs.existsSync(localEnv)) {
    loadEnvFile(localEnv)
    return
  }

  const gitFile = path.join(repoRoot, '.git')
  if (!fs.existsSync(gitFile) || !fs.statSync(gitFile).isFile()) return
  const gitdirMatch = fs
    .readFileSync(gitFile, 'utf8')
    .trim()
    .match(/^gitdir:\s*(.+)$/)
  if (!gitdirMatch) return
  const worktreeGitDir = path.resolve(repoRoot, gitdirMatch[1])
  const commonDirFile = path.join(worktreeGitDir, 'commondir')
  if (!fs.existsSync(commonDirFile)) return
  const commonDir = path.resolve(worktreeGitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
  loadEnvFile(path.join(commonDir, '..', '.env'))
}

loadCanonicalRootEnv()
// A lane-specific file may supply values missing from the canonical root env,
// but never overrides an explicit shell value or a value already loaded from
// the root. It is optional; the root .env remains the primary contract.
loadEnvFile(path.resolve(__dirname, '../../../.env.e2e'))

export default defineConfig({
  testDir: '.',
  // 240s: T1 in the cross-device suite can take 1–2m when the LLM cold-starts
  // and runs through multiple MCP tool approvals before producing the final
  // assistant response. 120s raced the outer test timeout against the 120s
  // waitFor inside the test.
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.resolve(__dirname, 'playwright-report') }],
  ],
  outputDir: path.resolve(__dirname, 'test-results'),
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
})
