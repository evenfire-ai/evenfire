import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import base from './playwright.config'

const repoRoot = path.resolve(__dirname, '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim()
const primaryRoot = path.dirname(common)
const selectedRun = process.env.E2E_CANONICAL_UI_RUN_ID
if (
  selectedRun &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(selectedRun)
)
  throw new Error('Invalid UI evidence run identity')
// Source collection has no runtime certification or fabricated Host binding.
const evidenceRoot = path.join(
  primaryRoot,
  '.local-notes/infra/runs/issue-825-ui',
  selectedRun || 'source-collection'
)
const defaultProject = base.projects?.find(project => project.name === 'default')
if (!defaultProject) throw new Error('Existing Desktop default project missing')
const privacy = { trace: 'off', screenshot: 'off', video: 'off' } as const
export default defineConfig({
  ...base,
  projects: [
    {
      ...defaultProject,
      name: 'canonical-store',
      testMatch: /canonical-store-lifecycle\.spec\.ts/,
      use: { ...defaultProject.use, ...privacy },
    },
  ],
  testMatch: /canonical-store-lifecycle\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: path.join(evidenceRoot, 'results'),
  reporter: [['list'], ['json', { outputFile: path.join(evidenceRoot, 'results.json') }]],
  // Pinned Playwright 1.58.2 serializes raw input values and auth headers.
  // Raw artifact criteria remain pending; no unsafe producer is started.
  use: { ...base.use, ...privacy },
})
