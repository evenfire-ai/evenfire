// desktop-app/test/e2e-playwright/playwright.config.ts
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/** Read a local file once, treating a missing optional file as absent. */
function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Parse dotenv data without overwriting an explicit process value. */
function loadEnvContents(contents: string): void {
  const lines = contents.split('\n')
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
    // Presence, not truthiness: an explicit empty process value is still an
    // operator decision and must not be replaced by a lane default.
    if (!(key in process.env)) process.env[key] = value
  }
}

/** Load a dotenv-style file without a check-then-read race. */
function loadEnvFile(envPath: string): void {
  const contents = readOptionalFile(envPath)
  if (contents !== null) loadEnvContents(contents)
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
  const gitFile = path.join(repoRoot, '.git')
  let gitFileContents: string
  try {
    gitFileContents = fs.readFileSync(gitFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      loadEnvFile(path.join(repoRoot, '.env'))
      return
    }
    // A normal checkout has a file-form worktree pointer here. If `.git` is a
    // directory (for example in a non-worktree checkout), there is no safe
    // common-dir traversal to perform from this config file.
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      loadEnvFile(path.join(repoRoot, '.env'))
      return
    }
    throw error
  }
  const gitdirMatch = gitFileContents.trim().match(/^gitdir:\s*(.+)$/)
  if (!gitdirMatch) {
    loadEnvFile(path.join(repoRoot, '.env'))
    return
  }
  const worktreeGitDir = path.resolve(repoRoot, gitdirMatch[1])
  const commonDirFile = path.join(worktreeGitDir, 'commondir')
  const commonDirValue = readOptionalFile(commonDirFile)
  if (commonDirValue === null) {
    loadEnvFile(path.join(repoRoot, '.env'))
    return
  }
  const commonDir = path.resolve(worktreeGitDir, commonDirValue.trim())
  // For a linked worktree, the canonical root is the parent of Git's common
  // directory (the primary checkout), not the secondary worktree containing
  // this config. This keeps seeded credentials and endpoint policy aligned
  // with the operator lane.
  loadEnvFile(path.join(commonDir, '..', '.env'))
}

loadCanonicalRootEnv()
// The Desktop lane-specific file is optional and only fills values missing
// from the canonical root env. Do not read a second root-level `.env.e2e`: that
// file belongs to another lane and previously masked desktop-app/.env.e2e.
loadEnvFile(path.resolve(__dirname, '../../.env.e2e'))

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
