import * as testApi from 'vitest'
import { defineDevJwtVerifierContract } from '../../test/helpers/devJwtVerifierContract.js'

defineDevJwtVerifierContract({
  testApi,
  service: 'rpc-proxy',
  slot: 'rpc',
  envName: 'RPC_PROXY_JWT_PUBLIC_KEY',
  configSource: new URL('../config.ts', import.meta.url),
  loadConfig: () => import('../config.js'),
})
