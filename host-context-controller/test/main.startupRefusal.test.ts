import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// main.ts has no importable seam: it calls main() at module load and exits the process.
// Spawn it and read what it prints before it stops. Outside dev mode k8sClient builds its
// API clients at import time, so the child needs a kubeconfig with a current context; this
// one points at a closed loopback port and is never dialled before the checks under test.
const packageRoot = join(__dirname, '..')
const tsNode = join(packageRoot, 'node_modules', 'ts-node', 'dist', 'bin.js')
const HMAC = { INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET: 'hcc-startup-test-hmac-0001' }
const DESKTOP_FATAL = '[HCC] FATAL: CONTEXT_MAPPER_DESKTOP_API_TOKEN'
const HMAC_FATAL = '[HCC] FATAL: INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET env var is required'
// The first refusal after the two secret checks; its presence proves both were passed.
const NEXT_FATAL = '[HCC] FATAL: HCC MCP JWT public key is required'

let scratch = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hcc-main-startup-'))
  writeFileSync(
    join(scratch, 'kubeconfig.yaml'),
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '  - name: synthetic',
      '    cluster:',
      '      server: https://127.0.0.1:1',
      'contexts:',
      '  - name: synthetic',
      '    context:',
      '      cluster: synthetic',
      '      user: synthetic',
      'users:',
      '  - name: synthetic',
      '    user: {}',
      'current-context: synthetic',
      '',
    ].join('\n')
  )
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function runMain(env: Record<string, string>) {
  const child = spawnSync(process.execPath, [tsNode, '--transpile-only', 'src/main.ts'], {
    cwd: packageRoot,
    env: { PATH: process.env.PATH ?? '', KUBECONFIG: join(scratch, 'kubeconfig.yaml'), ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: child.status, signal: child.signal, output: `${child.stdout}\n${child.stderr}` }
}

describe('main.ts start-up refusal for the desktop API token', () => {
  it.each([
    ['unset', {}, 'env var is required outside CLERUM_DEV_MODE'],
    [
      'empty',
      { CONTEXT_MAPPER_DESKTOP_API_TOKEN: '' },
      'env var is required outside CLERUM_DEV_MODE',
    ],
    [
      'whitespace only',
      { CONTEXT_MAPPER_DESKTOP_API_TOKEN: '   ' },
      'env var is required outside CLERUM_DEV_MODE',
    ],
    [
      'a placeholder',
      { CONTEXT_MAPPER_DESKTOP_API_TOKEN: 'replace-with-a-random-value' },
      'has placeholder value',
    ],
  ])(
    'exits 1 with [HCC] FATAL when the token is %s',
    (_label, tokenEnv, message) => {
      const run = runMain({ ...HMAC, ...tokenEnv })

      expect(run.signal).toBeNull()
      expect(run.status).toBe(1)
      expect(run.output).toContain(`${DESKTOP_FATAL} ${message}`)
      expect(run.output).not.toContain(NEXT_FATAL)
      expect(run.output).not.toContain('replace-with-a-random-value')
      expect(run.output).not.toContain('WARNING: CONTEXT_MAPPER_DESKTOP_API_TOKEN')
    },
    90_000
  )

  it('reports the HMAC secret first when both secrets are missing', () => {
    const run = runMain({})

    expect(run.status).toBe(1)
    expect(run.output).toContain(HMAC_FATAL)
    expect(run.output).not.toContain(DESKTOP_FATAL)
  }, 90_000)

  it('passes the check with a token and stops at the next start-up check', () => {
    const run = runMain({
      ...HMAC,
      CONTEXT_MAPPER_DESKTOP_API_TOKEN: 'hcc-startup-test-desktop-0001',
    })

    expect(run.status).toBe(1)
    expect(run.output).toContain(NEXT_FATAL)
    expect(run.output).not.toContain(DESKTOP_FATAL)
  }, 90_000)

  it('does not require the token in CLERUM_DEV_MODE', () => {
    const run = runMain({ CLERUM_DEV_MODE: 'true' })

    expect(run.status).toBe(1)
    expect(run.output).toContain('[Main] Mode: DEV')
    expect(run.output).toContain(NEXT_FATAL)
    expect(run.output).not.toContain(DESKTOP_FATAL)
  }, 90_000)
})
