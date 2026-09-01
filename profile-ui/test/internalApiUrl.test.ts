import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.join(process.cwd())

/** In-namespace Service name. Works in dedicated `profiles` and shared `profiles-<slug>`. */
const IN_NAMESPACE_API = 'http://external-rest-api:8091'
const DEDICATED_CLUSTER_FQDN = 'external-rest-api.profiles.svc.cluster.local'

test('next.config.js rewrite default is the in-namespace Service, not dedicated FQDN', () => {
  const src = fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8')
  assert.match(src, new RegExp(IN_NAMESPACE_API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(src, new RegExp(DEDICATED_CLUSTER_FQDN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('serverApi.ts default is the in-namespace Service, not dedicated FQDN', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/constants/serverApi.ts'), 'utf8')
  assert.match(src, new RegExp(IN_NAMESPACE_API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(src, new RegExp(DEDICATED_CLUSTER_FQDN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
