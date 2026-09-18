import { describe, expect, it } from 'vitest'
import {
  admitIsolationBaseDir,
  devIsolationRuntimePolicy,
  publicDevIsolationRecord,
  resolveDevIsolation,
  verifyDevIsolationRuntime,
} from '../devIsolation'

const env = {
  EVENFIRE_DEV_ISOLATION: '1',
  EVENFIRE_DEV_ISOLATION_RUN_DIR: '/tmp/isolated-run',
  EVENFIRE_DEV_ISOLATION_TARGET: 'minikube-30488',
  EVENFIRE_DEV_ISOLATION_PR: '660',
  EVENFIRE_DEV_ISOLATION_REST_URL: 'http://127.0.0.1:30579',
  EVENFIRE_DEV_ISOLATION_RPC_URL: 'http://127.0.0.1:30582',
  EVENFIRE_DEV_ISOLATION_APP_PATH: '/repo/desktop-app/dist',
  EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:30579',
  RPC_PROXY_BASE_URL: 'http://127.0.0.1:30582',
  CLERUM_DESKTOP_CONFIG_PATH: '/tmp/isolated-run/runtime-config.json',
}
const argv = [
  'electron',
  '--user-data-dir=/tmp/isolated-run/user-data',
  '/repo/desktop-app/dist/main.js',
]

describe('explicit development instance isolation', () => {
  it('leaves normal packaged and development launches unchanged', () => {
    expect(resolveDevIsolation({}, [], false)).toEqual({ mode: 'normal' })
    expect(resolveDevIsolation({}, [], true)).toEqual({ mode: 'normal' })
    expect(devIsolationRuntimePolicy(null)).toMatchObject({
      registerOsProtocols: true,
      acceptDeepLinks: true,
      pinWindowTitle: false,
    })
  })
  it('refuses an opt-in in a packaged application', () => {
    expect(resolveDevIsolation(env, argv, true)).toMatchObject({
      mode: 'refused',
      code: 'DEV_ISOLATION_PACKAGED',
    })
  })
  it('requires the explicit directory before single-instance/protocol setup', () => {
    expect(resolveDevIsolation(env, [])).toMatchObject({ mode: 'refused' })
    expect(resolveDevIsolation(env, ['--user-data-dir=/tmp/another-run'])).toMatchObject({
      mode: 'refused',
    })
  })
  it.each(['CLERUM_DESKTOP_CONFIG_PATH', 'EXTERNAL_REST_API_BASE_URL', 'RPC_PROXY_BASE_URL'])(
    'refuses missing or divergent %s',
    key => {
      expect(resolveDevIsolation({ ...env, [key]: '' }, argv)).toMatchObject({ mode: 'refused' })
      expect(resolveDevIsolation({ ...env, [key]: 'http://127.0.0.1:33333' }, argv)).toMatchObject({
        mode: 'refused',
      })
    }
  )
  it.each([
    'https://example.com:443',
    'http://user:pass@127.0.0.1:30579',
    'http://127.0.0.1:30579/?private=value',
  ])('refuses unsafe endpoint %s', value => {
    expect(
      resolveDevIsolation(
        { ...env, EVENFIRE_DEV_ISOLATION_REST_URL: value, EXTERNAL_REST_API_BASE_URL: value },
        argv
      )
    ).toMatchObject({ mode: 'refused' })
  })
  it('isolates OS routing and verifies effective identity before exposing metadata', () => {
    const result = resolveDevIsolation(env, argv)
    expect(result.mode).toBe('isolated')
    if (result.mode !== 'isolated') throw new Error('expected isolated plan')
    const { plan } = result
    expect(devIsolationRuntimePolicy(plan)).toMatchObject({
      registerOsProtocols: false,
      acceptDeepLinks: false,
      pinWindowTitle: true,
    })
    expect(plan.label).toContain('PR660')
    const observed = {
      pid: 123,
      userDataDir: plan.userDataDir,
      appPath: plan.appPath!,
      restUrl: plan.restUrl,
      rpcUrl: plan.rpcUrl,
      configStoragePath: plan.configPath,
      envKey: 'fixture-environment',
    }
    expect(verifyDevIsolationRuntime(plan, observed)).toEqual({ ok: true })
    expect(publicDevIsolationRecord(plan, observed).pid).toBe(123)
    for (const key of ['userDataDir', 'appPath', 'restUrl', 'rpcUrl', 'configStoragePath']) {
      const wrong = { ...observed, [key]: 'foreign-value' }
      expect(verifyDevIsolationRuntime(plan, wrong).ok).toBe(false)
      expect(() => publicDevIsolationRecord(plan, wrong)).toThrow('before runtime verification')
    }
  })
  it('rejects application data inside the checkout', () => {
    expect(
      admitIsolationBaseDir({
        requested: '/repo/private-run',
        repoRoot: '/repo',
        platform: 'darwin',
        homedir: '/home/user',
        env: {},
      })
    ).toMatchObject({ ok: false })
  })
})
