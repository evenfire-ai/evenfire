import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ALLOWED_CONTEXTS,
  assertAllowedKubeContext,
  assertBranchOwnedContext,
  assertHostedDevServices,
  isLocalPortForwardContext,
  isProductionContext,
  validateBaseUrls,
} from './e2e-playwright/global-setup'

const DEV_CONTEXT = 'gke_${GCP_PROJECT}_us-central1-a_example-dev'

describe('validateBaseUrls', () => {
  it('requires localhost for clerum-test', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-test',
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'https://dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: false,
      })
    ).toThrow(/local minikube context=clerum-test requires localhost URLs/)
  })

  it('allows generated branch minikube profile URLs through localhost port-forwards', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5',
        controlApiUrl: 'http://127.0.0.1:35784',
        externalRestUrl: 'http://127.0.0.1:35785',
        rpcProxyUrl: 'http://localhost:35788',
        allowDevPortForward: false,
      })
    ).not.toThrow()
  })

  it('rejects non-localhost urls for generated branch minikube profiles', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5',
        controlApiUrl: 'http://127.0.0.1:35784',
        externalRestUrl: 'https://profiles.dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:35788',
        allowDevPortForward: false,
      })
    ).toThrow(
      /local minikube context=clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5 requires localhost URLs/
    )
  })

  it('allows explicit dev port-forward mode for example-dev', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://localhost:8094',
        allowDevPortForward: true,
      })
    ).not.toThrow()
  })

  it('allows random localhost ports for branch-scoped minikube contexts', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-workflow-output-rwo-affinity-39eec1ac',
        controlUiUrl: 'http://127.0.0.1:33300',
        controlApiUrl: 'http://127.0.0.1:33330',
        externalRestUrl: 'http://127.0.0.1:33331',
        rpcProxyUrl: 'http://localhost:33334',
        workflowApprovalReaderUrl: 'http://127.0.0.1:33338',
        allowDevPortForward: true,
      })
    ).not.toThrow()
  })

  it('rejects shared default ports for branch-scoped minikube contexts', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-workflow-output-rwo-affinity-39eec1ac',
        controlUiUrl: 'http://127.0.0.1:3000',
        controlApiUrl: 'http://127.0.0.1:33330',
        externalRestUrl: 'http://127.0.0.1:33331',
        rpcProxyUrl: 'http://127.0.0.1:33334',
        allowDevPortForward: true,
      })
    ).toThrow(/CONTROL_UI_BASE_URL/)
  })

  it('rejects non-localhost urls when dev port-forward mode is enabled', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'https://profiles.dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: true,
      })
    ).toThrow(/E2E_ALLOW_DEV_PORT_FORWARD=1 requires localhost URLs/)
  })

  it('validates workflow approval reader URL when the quadrants suite provides it', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-test',
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        workflowApprovalReaderUrl: 'https://reader.example.com',
        allowDevPortForward: false,
      })
    ).toThrow(/WORKFLOW_APPROVAL_READER_BASE_URL/)
  })

  it('rejects localhost on example-dev without explicit opt-in', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: false,
      })
    ).toThrow(/requires non-localhost URLs/)
  })
})

describe('assertAllowedKubeContext', () => {
  it('accepts a branch profile and refuses production with the same call', () => {
    // Positive control: the guard returns for the context the A/B benchmark actually uses.
    expect(isLocalPortForwardContext('clerum-fix-issue-1091-chat-open-latency-d7ddc3ab')).toBe(true)
    expect(() =>
      assertAllowedKubeContext(
        'clerum-fix-issue-1091-chat-open-latency-d7ddc3ab',
        'CHAT_OPEN_AB_KUBE_CONTEXT'
      )
    ).not.toThrow()
    expect(isProductionContext('gke_example_us-central1-a_clerum-prod')).toBe(true)
    expect(() =>
      assertAllowedKubeContext('gke_example_us-central1-a_clerum-prod', 'CHAT_OPEN_AB_KUBE_CONTEXT')
    ).toThrow(/Production context .* is hard-blocked/)
  })

  it('refuses a context that is neither a local profile nor allow-listed', () => {
    expect(ALLOWED_CONTEXTS.has(DEV_CONTEXT)).toBe(false)
    expect(() => assertAllowedKubeContext(DEV_CONTEXT, 'CHAT_OPEN_AB_KUBE_CONTEXT')).toThrow(
      /CHAT_OPEN_AB_KUBE_CONTEXT=.* is not in the allow-list/
    )
  })
})

describe('assertHostedDevServices', () => {
  it('checks exactly the services the Desktop lane drives', () => {
    const asked: string[] = []
    assertHostedDevServices('dev', (_context, namespace, service) => {
      asked.push(`${namespace}/${service}`)
      return 'pod-1\n'
    })
    expect(asked).toEqual([
      'control-plane/control-api',
      'profiles/external-rest-api',
      'rpc-proxy/rpc-proxy',
    ])
  })

  it('accepts a hosted dev context whose services have a ready endpoint', () => {
    expect(() => assertHostedDevServices('dev', () => 'pod-1\n')).not.toThrow()
  })

  it('refuses a service without a ready endpoint', () => {
    expect(() => assertHostedDevServices('dev', () => '\n')).toThrow(
      /hosted dev context=dev has no ready endpoint for control-plane\/control-api/
    )
  })

  it('refuses an unreadable service instead of starting a journey against it', () => {
    expect(() =>
      assertHostedDevServices('dev', () => {
        throw new Error('connection refused')
      })
    ).toThrow(/has no readable endpoint for control-plane\/control-api: connection refused/)
  })
})

describe('assertBranchOwnedContext', () => {
  it.each(['clerum-test', 'clerum-prod-abc12345', 'clerum-dev', DEV_CONTEXT])(
    'refuses %s',
    context => {
      expect(() => assertBranchOwnedContext(context)).toThrow(/not a branch-owned local profile/)
    }
  )

  it.each([
    'clerum-feat-plugin-workload-sdk-3de2a246',
    'clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5',
  ])('accepts %s', context => {
    expect(() => assertBranchOwnedContext(context)).not.toThrow()
  })
})

describe('session team UX lane admission', () => {
  const CONFIG = './e2e-playwright/playwright.session-team-ux.config'
  const BRANCH_CONTEXT = 'clerum-feat-plugin-workload-sdk-3de2a246'
  const VALID_ENV = {
    E2E_SESSION_TEAM_UX: '1',
    E2E_K8S_CONTEXT: BRANCH_CONTEXT,
    EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:38091',
  }
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  async function loadConfig(env: Record<string, string>) {
    vi.resetModules()
    // An empty value counts as present, so the developer's canonical .env cannot fill it.
    Object.assign(process.env, env)
    const [{ default: config }, { default: base }] = await Promise.all([
      import(CONFIG),
      import('./e2e-playwright/playwright.config'),
    ])
    return { config, base }
  }

  it.each([
    ['the opt-in', { E2E_SESSION_TEAM_UX: '' }, /requires E2E_SESSION_TEAM_UX=1/],
    ['the context', { E2E_K8S_CONTEXT: '' }, /requires explicit E2E_K8S_CONTEXT/],
    [
      'the base URL',
      { EXTERNAL_REST_API_BASE_URL: '' },
      /requires explicit EXTERNAL_REST_API_BASE_URL/,
    ],
    ['a branch context', { E2E_K8S_CONTEXT: 'clerum-test' }, /not a branch-owned local profile/],
  ])('rejects a config without %s', async (_label, override, message) => {
    await expect(loadConfig({ ...VALID_ENV, ...override })).rejects.toThrow(message)
  })

  it('inherits the base global setup and runs only this lane under a valid env', async () => {
    const { config, base } = await loadConfig(VALID_ENV)

    expect(base.globalSetup).toBeTruthy()
    expect(config.globalSetup).toBe(base.globalSetup)
    expect(config.projects).toEqual([
      { name: 'session-team-ux', testMatch: '**/session-team-ux.test.ts' },
    ])
  })

  it('imports the base config before global-setup, which reads the canonical env at load', () => {
    const source = readFileSync(path.resolve(__dirname, `${CONFIG}.ts`), 'utf8')
    const baseImport = source.indexOf("from './playwright.config'")
    expect(baseImport).toBeGreaterThan(-1)
    expect(baseImport).toBeLessThan(source.indexOf("from './global-setup'"))
  })

  it('lists exactly the lane tests through the Playwright CLI', () => {
    const desktopApp = path.resolve(__dirname, '..')
    const list = (env: Record<string, string>) =>
      spawnSync(
        path.join(desktopApp, 'node_modules/.bin/playwright'),
        ['test', '--list', '--config', 'test/e2e-playwright/playwright.session-team-ux.config.ts'],
        { cwd: desktopApp, encoding: 'utf8', env: { ...originalEnv, ...env }, timeout: 120_000 }
      )

    const listed = list(VALID_ENV)
    expect(listed.status, listed.stderr).toBe(0)
    const tests = listed.stdout.split('\n').filter(line => line.includes('.test.ts:'))
    expect(tests.length).toBeGreaterThan(0)
    for (const line of tests) expect(line).toContain('session-team-ux.test.ts')
    expect(listed.stdout).toMatch(/Total: \d+ tests? in 1 file/)

    expect(list({ ...VALID_ENV, E2E_SESSION_TEAM_UX: '' }).status).not.toBe(0)
  }, 240_000)
})
