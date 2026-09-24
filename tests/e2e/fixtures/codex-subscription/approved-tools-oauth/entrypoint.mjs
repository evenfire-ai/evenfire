import { writeFile } from 'node:fs/promises'
import { createOAuthFixtureFetch, validateFixtureEnvironment } from './provider.mjs'

validateFixtureEnvironment(process.env)
globalThis.fetch = createOAuthFixtureFetch(globalThis.fetch.bind(globalThis))
await writeFile(
  '/tmp/approved-tools-oauth-active.json',
  JSON.stringify({
    run: process.env.APPROVED_TOOLS_RUN_ID,
    profile: process.env.MINIKUBE_PROFILE,
    pid: process.pid,
  }),
  { flag: 'wx', mode: 0o600 }
)
await import('/app/control-api/dist/main.js')
