import { vi } from 'vitest'
import { electronMocks } from './sandboxUiElectronFakes.js'

// Stand-ins for the modules a suite running the REAL sandbox-ui main process
// (`sandboxUiRealMain.ts`) does not stand up. `vi.mock` is hoisted per test
// file, so each suite still declares the mocks itself and takes the module
// from here:
//   vi.mock('<src>/config.js', async () =>
//     (await import('<fixtures>/sandboxUiMainModuleMocks')).configModule)
// This module must not import the AppService (or anything that imports one of
// the modules it stands for): a mock factory that does would wait on itself.

export const configModule = {
  getActiveEnvKey: () => 'test-env',
  getActiveLegacyEnvKeys: () => [],
  config: {
    rpcProxyBaseUrl: 'https://rpc.example',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    desktopProfileUiBaseUrlExplicit: false,
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}

export const partitionGcModule = {
  touchSandboxUiPartition: electronMocks.touchSandboxUiPartition,
}

// The RPC token is issued by control-api through external-rest-api, a layer
// these suites do not stand up; the mint itself runs through the real
// RpcProxyClient.
export const rpcTokenManagerModule = {
  RpcTokenManager: class {
    getOrIssue = vi.fn(async () => ({ token: 'fake-rpc-token' }))
    clear = vi.fn()
    getMetadata = vi.fn(() => ({ expiresAtMs: null, scopes: [], hostRefs: [] }))
  },
}

export const authClientModule = {
  AuthClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    getMe = vi.fn()
  },
}

export const tokenStoreModule = {
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
  },
}
