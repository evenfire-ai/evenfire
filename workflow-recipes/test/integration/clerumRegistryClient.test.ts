/**
 * Integration tests for clerumRegistryClient against a live registry.
 *
 * Requires a running registry server reachable at TEST_REGISTRY_URL
 * (any server implementing the registry contract — npm-style /:name and
 * OCI-style /api/v1/entries routes). Run locally:
 *   docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 15432:5432 postgres:16-alpine
 *   # Start your registry server (see your private deployment runbook for setup)
 *   # then export the URL:
 *   TEST_REGISTRY_URL=http://127.0.0.1:18085 npm test test/integration/clerumRegistryClient.test.ts
 *
 * In CI: set TEST_REGISTRY_URL to point at a running registry server before
 * running this suite.
 *
 * Skip when TEST_REGISTRY_URL is unset so `npm test` doesn't fail when a
 * developer runs the full WRC suite without booting a registry.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  __resetTokenCacheForTests,
  getEntry,
  getEntryVersion,
  mintToken,
  reportInstall,
  searchEntries,
} from '../../src/registry/clerumRegistryClient.js'

const TEST_REGISTRY_URL = process.env.TEST_REGISTRY_URL
const HAS_REGISTRY = !!TEST_REGISTRY_URL

const env = HAS_REGISTRY
  ? { url: TEST_REGISTRY_URL!, authEnabled: false }
  : { url: 'http://unused', authEnabled: false }

beforeAll(() => {
  __resetTokenCacheForTests()
  if (!HAS_REGISTRY) {
    // eslint-disable-next-line no-console
    console.warn('TEST_REGISTRY_URL not set; skipping clerumRegistryClient integration tests')
  }
})

describe('clerumRegistryClient against a live registry', () => {
  it.skipIf(!HAS_REGISTRY)('mintToken returns "" when authEnabled=false', async () => {
    const t = await mintToken(env)
    expect(t).toBe('')
  })

  it.skipIf(!HAS_REGISTRY)('searchEntries returns {results, total} shape', async () => {
    const res = await searchEntries({ limit: 5 }, env)
    expect(Array.isArray(res.results)).toBe(true)
    expect(typeof res.total).toBe('number')
  })

  it.skipIf(!HAS_REGISTRY)('searchEntries honors limit', async () => {
    const res = await searchEntries({ limit: 1 }, env)
    expect(res.results.length).toBeLessThanOrEqual(1)
  })

  it.skipIf(!HAS_REGISTRY)('getEntry returns null for an unknown entry', async () => {
    const res = await getEntry('definitely-not-a-real-entry-xyz', env)
    expect(res).toBeNull()
  })

  it.skipIf(!HAS_REGISTRY)('getEntry encodes scoped names per npm convention', async () => {
    // We can't easily seed a scoped entry without auth-on, so just verify
    // the URL shape resolves correctly: a missing scoped name must 404, not
    // 500 or 400, proving the path was routed to /:name with the decoded
    // scope intact.
    const res = await getEntry('@npmstyle/nonexistent', env)
    expect(res).toBeNull()
  })

  it.skipIf(!HAS_REGISTRY)('getEntryVersion returns null on missing version', async () => {
    const res = await getEntryVersion('definitely-not-a-real-entry-xyz', '1.0.0', env)
    expect(res).toBeNull()
  })

  // Note: tests that require a seeded entry (positive getEntry / getEntryVersion
  // for an existing name, reportInstall against a real entry) live in the bash
  // E2E suite (scripts/e2e/e2e-registry-decoupling.sh) which runs against a
  // primed cluster registry. Seeding from CI would require enabling auth on
  // the registry just to get a user-mode caller (the entries.owner_type column
  // is NOT NULL and machine callers get owner_type=null). The bash suite
  // already covers that surface; here we exercise the consumer's wire shape
  // and error paths without needing a seed.

  it.skipIf(!HAS_REGISTRY)('reportInstall does not throw on a network error', async () => {
    // Point at a guaranteed-dead host to force the catch path.
    await expect(
      reportInstall('ci-test-entry', '1.0.0', { url: 'http://127.0.0.1:1', authEnabled: false })
    ).resolves.toBeUndefined()
  })
})
