import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatReleaseLabel,
  formatReleaseTitle,
  loadReleaseIdentity,
  normalizeReleaseIdentity,
  refreshReleaseIdentity,
  resetReleaseIdentityCache,
  subscribeReleaseIdentity,
} from '../lib/releaseIdentity'
import type { ReleaseIdentity } from '../lib/releaseIdentity'

test('normalizeReleaseIdentity keeps a trimmed release id', () => {
  assert.deepEqual(normalizeReleaseIdentity({ releaseId: ' v0.6.0 ' }), {
    releaseId: 'v0.6.0',
    buildRevision: '',
  })
})

test('normalizeReleaseIdentity keeps the build revision when the image serves one', () => {
  assert.deepEqual(normalizeReleaseIdentity({ releaseId: 'v0.6.0', buildRevision: ' 4be949d ' }), {
    releaseId: 'v0.6.0',
    buildRevision: '4be949d',
  })
})

// An external-rest-api image built before the build stamp landed omits the
// field entirely. That must read as "no build", not break the identity.
test('normalizeReleaseIdentity tolerates a payload with no build revision', () => {
  assert.deepEqual(normalizeReleaseIdentity({ releaseId: 'v0.6.0', buildRevision: 42 }), {
    releaseId: 'v0.6.0',
    buildRevision: '',
  })
})

test('normalizeReleaseIdentity rejects payloads that carry no release id', () => {
  assert.equal(normalizeReleaseIdentity({ releaseId: '   ' }), null)
  assert.equal(normalizeReleaseIdentity({}), null)
  assert.equal(normalizeReleaseIdentity(null), null)
  assert.equal(normalizeReleaseIdentity('v0.6.0'), null)
})

// String() coercion would turn any of these into a truthy label: an object
// becomes "[object Object]", a number becomes its digits.
test('normalizeReleaseIdentity rejects a release id that is not a string', () => {
  assert.equal(normalizeReleaseIdentity({ releaseId: { tag: 'v0.6.0' } }), null)
  assert.equal(normalizeReleaseIdentity({ releaseId: ['v0.6.0'] }), null)
  assert.equal(normalizeReleaseIdentity({ releaseId: 6 }), null)
  assert.equal(normalizeReleaseIdentity({ releaseId: true }), null)
})

test('formatReleaseTitle shares one prefix with the settings label', () => {
  assert.equal(formatReleaseTitle('v0.6.0'), 'Release v0.6.0')
  assert.equal(formatReleaseTitle('v0.6.0'), formatReleaseLabel('v0.6.0'))
})

// Between releases the release id is frozen, so the build is the only part that
// tells you what is actually running.
test('formatReleaseTitle names the build alongside the release', () => {
  assert.equal(formatReleaseTitle('v0.6.0', '4be949d'), 'Release v0.6.0 (build 4be949d)')
})

test('formatReleaseTitle omits an empty build rather than showing an empty pair', () => {
  assert.equal(formatReleaseTitle('v0.6.0', ''), 'Release v0.6.0')
})

// The settings header is for users; the build belongs in the support-facing
// tooltip only.
test('formatReleaseLabel never carries the build revision', () => {
  assert.equal(formatReleaseLabel('v0.6.0'), 'Release v0.6.0')
})

// The sidebar brand needs an absent title, not the word "unavailable".
test('formatReleaseTitle yields no title when the release is unknown', () => {
  assert.equal(formatReleaseTitle(null), undefined)
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

  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0', buildRevision: '' })
  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0', buildRevision: '' })
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
  assert.deepEqual(first, { releaseId: 'v0.6.0', buildRevision: '' })
  assert.deepEqual(second, { releaseId: 'v0.6.0', buildRevision: '' })
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
  assert.deepEqual(await loadReleaseIdentity(fetcher), { releaseId: 'v0.6.0', buildRevision: '' })
  assert.equal(calls, 2)
})

test('loadReleaseIdentity swallows a rejected read instead of surfacing it', async () => {
  resetReleaseIdentityCache()
  const fetcher = async () => {
    throw new Error('401 Unauthorized')
  }

  assert.equal(await loadReleaseIdentity(fetcher), null)
})

test('subscribeReleaseIdentity publishes a resolved read to every listener', async () => {
  resetReleaseIdentityCache()
  const seen: Array<ReleaseIdentity | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(async () => ({ releaseId: 'v0.6.0', buildRevision: '' }))
  unsubscribe()

  assert.deepEqual(seen, [{ releaseId: 'v0.6.0', buildRevision: '' }])
})

test('subscribeReleaseIdentity publishes a failed read so labels can fall back', async () => {
  resetReleaseIdentityCache()
  const seen: Array<ReleaseIdentity | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(async () => {
    throw new Error('503 Service Unavailable')
  })
  unsubscribe()

  assert.deepEqual(seen, [null])
})

test('subscribeReleaseIdentity stops publishing once unsubscribed', async () => {
  resetReleaseIdentityCache()
  const seen: Array<ReleaseIdentity | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))
  unsubscribe()

  await loadReleaseIdentity(async () => ({ releaseId: 'v0.6.0', buildRevision: '' }))

  assert.deepEqual(seen, [])
})

// The settings Refresh button routes through here. Without it, a label that
// caught a transient failure stays on "unavailable" until it remounts.
test('refreshReleaseIdentity re-reads past a cached value and republishes', async () => {
  resetReleaseIdentityCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return { releaseId: calls === 1 ? 'v0.6.0' : 'v0.7.0' }
  }
  const seen: Array<ReleaseIdentity | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(fetcher)
  await loadReleaseIdentity(fetcher)
  assert.equal(calls, 1)

  assert.deepEqual(await refreshReleaseIdentity(fetcher), {
    releaseId: 'v0.7.0',
    buildRevision: '',
  })
  unsubscribe()

  assert.equal(calls, 2)
  assert.deepEqual(seen, [
    { releaseId: 'v0.6.0', buildRevision: '' },
    { releaseId: 'v0.7.0', buildRevision: '' },
  ])
})
