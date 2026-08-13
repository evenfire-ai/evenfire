import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatReleaseLabel,
  loadReleaseIdentity,
  normalizeReleaseIdentity,
  resetReleaseIdentityCache,
} from '../lib/releaseIdentity'

test('normalizeReleaseIdentity keeps a trimmed release id', () => {
  assert.deepEqual(normalizeReleaseIdentity({ releaseId: ' v0.6.0 ' }), { releaseId: 'v0.6.0' })
})

test('normalizeReleaseIdentity rejects payloads that carry no release id', () => {
  assert.equal(normalizeReleaseIdentity({ releaseId: '   ' }), null)
  assert.equal(normalizeReleaseIdentity({}), null)
  assert.equal(normalizeReleaseIdentity(null), null)
  assert.equal(normalizeReleaseIdentity('v0.6.0'), null)
})

test('formatReleaseLabel names the release once it is known', () => {
  assert.equal(formatReleaseLabel('v0.6.0'), 'Release v0.6.0')
})

test('formatReleaseLabel holds the line while the release is being read', () => {
  assert.equal(formatReleaseLabel(null, true), 'Release ...')
})

test('formatReleaseLabel says so when the release could not be read', () => {
  assert.equal(formatReleaseLabel(null, false), 'Release unavailable')
})

test('loadReleaseIdentity caches a resolved read for the page session', async () => {
  resetReleaseIdentityCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return { releaseId: 'v0.6.0' }
  }

  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0' })
  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0' })
  assert.equal(calls, 1)
})

test('loadReleaseIdentity shares one in-flight read between concurrent callers', async () => {
  resetReleaseIdentityCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return { releaseId: 'v0.6.0' }
  }

  const [first, second] = await Promise.all([
    loadReleaseIdentity(fetcher),
    loadReleaseIdentity(fetcher),
  ])
  assert.deepEqual(first, { releaseId: 'v0.6.0' })
  assert.deepEqual(second, { releaseId: 'v0.6.0' })
  assert.equal(calls, 1)
})

// A cached failure would pin the label to "unavailable" until the next full
// page load, which is the wrong trade for a read that is only decoration.
test('loadReleaseIdentity does not cache a failed read', async () => {
  resetReleaseIdentityCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    if (calls === 1) throw new Error('503 Service Unavailable')
    return { releaseId: 'v0.6.0' }
  }

  assert.equal(await loadReleaseIdentity(fetcher), null)
  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0' })
  assert.equal(calls, 2)
})

test('loadReleaseIdentity swallows a rejected read instead of surfacing it', async () => {
  resetReleaseIdentityCache()
  const fetcher = async () => {
    throw new Error('401 Unauthorized')
  }

  assert.equal(await loadReleaseIdentity(fetcher), null)
})
