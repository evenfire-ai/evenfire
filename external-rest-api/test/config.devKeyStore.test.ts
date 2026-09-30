import * as testApi from 'vitest'
import { defineDevJwtVerifierContract } from '../../rpc-proxy/test/helpers/devJwtVerifierContract.js'

defineDevJwtVerifierContract({
  testApi,
  service: 'external-rest-api',
  slot: 'session',
  envName: 'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
  configSource: new URL('../src/config.ts', import.meta.url),
  loadConfig: () => import('../src/config.js'),
})
