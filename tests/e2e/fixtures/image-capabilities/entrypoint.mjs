import { renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createImageFixtureFetch, validateFixtureEnvironment } from './provider.mjs'

validateFixtureEnvironment(process.env)
if (process.env.CLERUM_HOST_NAME !== 'chatllm')
  throw new Error('Fixture requires the isolated chatllm Host')
const runId = process.env.IMAGE_CAPABILITIES_RUN_ID
const profile = process.env.MINIKUBE_PROFILE
const marker = { runId, profile, pid: process.pid }
const evidencePath = '/tmp/image-capabilities-evidence.json'
const persist = evidence => {
  writeFileSync(`${evidencePath}.next`, JSON.stringify({ ...marker, ...evidence }), { mode: 0o600 })
  renameSync(`${evidencePath}.next`, evidencePath)
}
const fixture = createImageFixtureFetch(globalThis.fetch.bind(globalThis), {
  runId,
  credentialHash: process.env.IMAGE_CAPABILITIES_CREDENTIAL_SHA256,
  onEvidence: persist,
})
globalThis.fetch = fixture.fetch
// The pinned OpenAI v4 SDK defaults to node-fetch, not globalThis.fetch. Select
// its documented web shim before the CommonJS production provider is loaded.
// Refuse startup if that SDK no longer binds to the isolated HTTP boundary.
const require = createRequire('/app/mcp-host/package.json')
require('openai/shims/web')
const { APIClient } = require('openai/core')
const probe = new APIClient({ baseURL: 'http://127.0.0.1', maxRetries: 0, timeout: 1000 })
if (probe.fetch !== fixture.fetch)
  throw new Error('SDK did not install the isolated provider boundary')
persist(fixture.getEvidence())
// Docker starts the real Host as Node's main program after this preload. Its
// require.main guard and crash handlers must execute exactly as in production.
