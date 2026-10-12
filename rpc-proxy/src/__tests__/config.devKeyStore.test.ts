import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { createDevJwtVerifierContract } from '../../../scripts/testing/devJwtVerifierContract.js'

const contract = createDevJwtVerifierContract({
  service: 'rpc-proxy',
  slot: 'rpc',
  envName: 'RPC_PROXY_JWT_PUBLIC_KEY',
  configSource: new URL('../config.ts', import.meta.url),
  loadConfig: () => import('../config.js'),
  resetModules: () => vi.resetModules(),
})

beforeAll(contract.prepare, 60_000)
beforeEach(contract.reset)
afterEach(contract.cleanup)
afterAll(contract.dispose)
describe('rpc-proxy dev JWT verifier contract', () => {
  for (const testCase of contract.cases) it(testCase.name, testCase.run, 30_000)
})
