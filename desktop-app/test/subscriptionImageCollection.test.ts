import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// Unit-only filesystem boundary: importing the general config cannot read any
// personal/canonical environment file. This is config coverage, not an E2E mock.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: () => {
        throw Object.assign(new Error('unit optional file absent'), { code: 'ENOENT' })
      },
    },
  }
})
afterEach(() => vi.unstubAllEnvs())
const realFs = createRequire(import.meta.url)('node:fs') as typeof fs
const desktopRoot = path.resolve(__dirname, '..')
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')

function collectionEnv(root: string): NodeJS.ProcessEnv {
  // Synthetic bindings only test collection; no runtime receipt exists and no
  // fixture activates. The actual runner must supply physically verified data.
  return {
    PATH: path.dirname(process.execPath),
    HOME: root,
    E2E_SUBSCRIPTION_IMAGE_INPUT: '1',
    E2E_SUBSCRIPTION_IMAGE_MODE: 'fixture',
    SUBSCRIPTION_IMAGE_FIXTURE_CONFIRM: '1',
    E2E_SUBSCRIPTION_IMAGE_RUN_ID: 'subscription-image-123456abcdef',
    SUBSCRIPTION_IMAGE_RUNNER_RECEIPT: path.join(root, 'intentionally-absent-receipt.json'),
    SUBSCRIPTION_IMAGE_RUN_ROOT: root,
    E2E_GROK_IMAGE_EVIDENCE_PATH: path.join(root, 'grok.json'),
    E2E_CODEX_IMAGE_EVIDENCE_PATH: path.join(root, 'codex.json'),
    MINIKUBE_PROFILE: 'unit-collection',
    CONTROL_API_REAL_PG_CONTEXT: 'unit-collection',
    EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:34001',
    RPC_PROXY_BASE_URL: 'http://127.0.0.1:34002',
    E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL: 'unit@fixture.invalid',
    E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD: ['unit', 'collection'].join('-'),
    E2E_GROK_IMAGE_HOST_REF: 'unit-grok',
    E2E_GROK_IMAGE_HOST_LABEL: 'Unit Grok',
    E2E_GROK_IMAGE_MODEL: 'unit-grok-image',
    E2E_GROK_IMAGE_MODEL_LABEL: 'Unit Grok Image',
    E2E_GROK_IMAGE_UNSUPPORTED_MODEL: 'unit-grok-text',
    E2E_GROK_IMAGE_UNSUPPORTED_MODEL_LABEL: 'Unit Grok Text',
    E2E_CODEX_IMAGE_HOST_REF: 'unit-codex',
    E2E_CODEX_IMAGE_HOST_LABEL: 'Unit Codex',
    E2E_CODEX_IMAGE_MODEL: 'unit-codex-image',
    E2E_CODEX_IMAGE_MODEL_LABEL: 'Unit Codex Image',
    E2E_CODEX_IMAGE_UNSUPPORTED_MODEL: 'unit-codex-text',
    E2E_CODEX_IMAGE_UNSUPPORTED_MODEL_LABEL: 'Unit Codex Text',
  }
}
function list(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [cli, 'test', '--config=test/e2e-playwright/playwright.subscription-image.config.ts', '--list'],
    { cwd: desktopRoot, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024 }
  )
}

describe('subscription image configuration collection safety', () => {
  it('the actual general project config excludes the dedicated suite without reading environment files', async () => {
    vi.stubEnv('EVENFIRE_ENV_FILE_PRESENT', '0')
    const { default: config } = await import('./e2e-playwright/playwright.config.js')
    const project = config.projects?.find(project => project.name === 'default')
    expect(project?.testIgnore).toContain('**/subscription-image-input.spec.ts')
  })
  it('actual Playwright config rejects absent opt-ins before any fixture activation', () => {
    const result = list({ PATH: path.dirname(process.execPath) })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('requires E2E_SUBSCRIPTION_IMAGE_INPUT=1')
    expect(result.stdout + result.stderr).not.toContain('Physical runner')
  })
  it('actual dedicated list selects all fourteen provider journeys without opening a nonexistent receipt or launching Electron', () => {
    const root = realFs.mkdtempSync(path.join(os.tmpdir(), 'subscription-image-collection-unit-'))
    try {
      const result = list(collectionEnv(root))
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Total: 14 tests in 1 file')
      expect(result.stdout).toContain('grok-subscription')
      expect(result.stdout).toContain('codex-subscription')
      expect(result.stdout).not.toContain('codex-image-input.spec.ts')
      expect(realFs.existsSync(path.join(root, 'intentionally-absent-receipt.json'))).toBe(false)
    } finally {
      realFs.rmSync(root, { recursive: true, force: true })
    }
  })
})
