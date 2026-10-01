import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { createDevJwtVerifierContract } from '../../scripts/testing/devJwtVerifierContract.js'

const contract = createDevJwtVerifierContract({
  service: 'external-rest-api',
  slot: 'session',
  envName: 'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
  configSource: new URL('../src/config.ts', import.meta.url),
  loadConfig: () => import('../src/config.js'),
  resetModules: () => vi.resetModules(),
})

beforeAll(contract.prepare, 60_000)
beforeEach(contract.reset)
afterEach(contract.cleanup)
afterAll(contract.dispose)
describe('external-rest-api dev JWT verifier contract', () => {
  for (const testCase of contract.cases) it(testCase.name, testCase.run, 30_000)
})
