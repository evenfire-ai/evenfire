import { defineConfig } from '@playwright/test'
import type { PlaywrightTestConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

function loadEnvFile(envPath: string) {
  let contents: string
  try {
    contents = fs.readFileSync(envPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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
    if (!(key in process.env)) process.env[key] = value
  }
  return true
}

function loadRootEnv() {
  const repoRoot = path.resolve(__dirname, '..')
  if (loadEnvFile(path.join(repoRoot, '.env'))) return
  const gitCommonDir = path.resolve(repoRoot, '.git')
  let gitFile: string
  try {
    gitFile = fs.readFileSync(gitCommonDir, 'utf8').trim()
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'EISDIR'
    )
      return
    throw error
  }
  const match = gitFile.match(/^gitdir:\s*(.+)$/)
  if (!match) return
  const worktreeGitDir = path.resolve(repoRoot, match[1])
  const commonDirPath = path.join(worktreeGitDir, 'commondir')
  const commonDir = fs.readFileSync(commonDirPath, 'utf8').trim()
  const mainGitDir = path.resolve(worktreeGitDir, commonDir)
  loadEnvFile(path.join(mainGitDir, '..', '.env'))
}

loadRootEnv()

const gfsAuthCrossBrowserProjects: NonNullable<PlaywrightTestConfig['projects']> =
  process.env.E2E_GFS_AUTH_CROSS_BROWSER === '1'
    ? [
        {
          name: 'chrome-gfs-auth',
          testMatch: /gfs-operator-journey\.spec\.ts/,
          grep: /authenticated operator reaches Global File System/,
          use: { channel: 'chrome' },
        },
        {
          name: 'firefox-gfs-auth',
          testMatch: /gfs-operator-journey\.spec\.ts/,
          grep: /authenticated operator reaches Global File System/,
          use: { browserName: 'firefox' },
        },
      ]
    : []

// Reporter is fixed to `list` at config level (instead of defaulting to the
// `line` reporter that buffers output) so that background runs — and the
// wrapper scripts in scripts/e2e/run-e2e-*.sh — always emit a line-per-test
// progress stream. A previous run of the registry suite in the background
// produced a silent stall because `line` reporter rewrites the last line;
// keeping `list` here makes the contract consistent across minikube and
// the example-dev GKE wrappers. Override with `--reporter=<name>` on the CLI
// when you need html/json for CI artifacts.
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/support/**',
  timeout: 300_000, // 5 min default — long-running workflow specs override via test.setTimeout()
  expect: { timeout: 120_000 },
  reporter: [['list']],
  use: {
    baseURL:
      process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  retries: 0,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    ...gfsAuthCrossBrowserProjects,
  ],
})
