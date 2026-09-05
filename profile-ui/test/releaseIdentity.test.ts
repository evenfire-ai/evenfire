import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatReleaseLabel,
  formatReleaseTitle,
  loadReleaseIdentity,
  normalizeReleaseIdentity,
  readCachedReleaseIdentity,
  refreshReleaseIdentity,
  resetReleaseIdentityCache,
  subscribeReleaseIdentity,
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

test('subscribeReleaseIdentity publishes a resolved read to every listener', async () => {
  resetReleaseIdentityCache()
  const seen: Array<{ releaseId: string } | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(async () => ({ releaseId: 'v0.6.0' }))
  unsubscribe()

  assert.deepEqual(seen, [{ releaseId: 'v0.6.0' }])
})

test('subscribeReleaseIdentity publishes a failed read so labels can fall back', async () => {
  resetReleaseIdentityCache()
  const seen: Array<{ releaseId: string } | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(async () => {
    throw new Error('503 Service Unavailable')
  })
  unsubscribe()

  assert.deepEqual(seen, [null])
})

test('subscribeReleaseIdentity stops publishing once unsubscribed', async () => {
  resetReleaseIdentityCache()
  const seen: Array<{ releaseId: string } | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))
  unsubscribe()

  await loadReleaseIdentity(async () => ({ releaseId: 'v0.6.0' }))

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
  const seen: Array<{ releaseId: string } | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(fetcher)
  await loadReleaseIdentity(fetcher)
  assert.equal(calls, 1)

  assert.deepEqual(await refreshReleaseIdentity(fetcher), { releaseId: 'v0.7.0' })
  unsubscribe()

  assert.equal(calls, 2)
  assert.deepEqual(seen, [{ releaseId: 'v0.6.0' }, { releaseId: 'v0.7.0' }])
})

// Refresh used to null the cache *before* the new read resolved. A transient
// 502 then published null to every mounted label, turning a correct
// "Release v0.7.0" into "Release unavailable" until the next successful
// refresh or a full reload.
test('refreshReleaseIdentity keeps the last good identity when the re-read fails', async () => {
  resetReleaseIdentityCache()
  const seen: Array<{ releaseId: string } | null> = []
  const unsubscribe = subscribeReleaseIdentity(identity => seen.push(identity))

  await loadReleaseIdentity(async () => ({ releaseId: 'v0.7.0' }))
  const refreshed = await refreshReleaseIdentity(async () => {
    throw new Error('502 Bad Gateway')
  })
  unsubscribe()

  assert.deepEqual(refreshed, { releaseId: 'v0.7.0' })
  assert.deepEqual(readCachedReleaseIdentity(), { releaseId: 'v0.7.0' })
  assert.deepEqual(seen, [{ releaseId: 'v0.7.0' }])
})

// refreshReleaseIdentity used to leave inFlight alone, so a Refresh during
// the mount read returned that same promise and never issued a second
// request — the button existed to repair a stuck read and did nothing.
test('refreshReleaseIdentity starts a new read while one is already in flight', async () => {
  resetReleaseIdentityCache()
  let calls = 0
  let finishFirst: ((value: { releaseId: string }) => void) | undefined
  const firstPayload = new Promise<{ releaseId: string }>(resolve => {
    finishFirst = resolve
  })
  const fetcher = async () => {
    calls += 1
    if (calls === 1) return firstPayload
    return { releaseId: 'v0.8.0-NEW' }
  }

  const firstLoad = loadReleaseIdentity(fetcher)
  const refreshed = refreshReleaseIdentity(fetcher)
  assert.equal(calls, 2)

  const refreshedIdentity = await refreshed
  finishFirst!({ releaseId: 'v0.7.0-OLD' })
  await firstLoad

  assert.deepEqual(refreshedIdentity, { releaseId: 'v0.8.0-NEW' })
  assert.deepEqual(readCachedReleaseIdentity(), { releaseId: 'v0.8.0-NEW' })
})

// publishReleaseIdentity used to run inside the fetch try. A throwing
// subscriber was caught as if the read itself had failed, which published
// null over the good value and returned null from the load.
test('a throwing subscriber does not wipe a resolved release identity', async () => {
  resetReleaseIdentityCache()
  const unsubscribe = subscribeReleaseIdentity(() => {
    throw new Error('subscriber failed')
  })

  const identity = await loadReleaseIdentity(async () => ({ releaseId: 'v0.7.0' }))
  unsubscribe()

  assert.deepEqual(identity, { releaseId: 'v0.7.0' })
  assert.deepEqual(readCachedReleaseIdentity(), { releaseId: 'v0.7.0' })
})
