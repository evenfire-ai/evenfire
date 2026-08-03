import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requestApprovalTargets,
  requestManageableTeams,
  resetProfileAccessCache,
} from '../lib/profileAccess'

test('profile access requests are cached and deduplicated per user', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input)
    requests.push(url)
    return new Response(JSON.stringify({ items: [] }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  try {
    resetProfileAccessCache()
    await Promise.all([
      requestManageableTeams('user-1'),
      requestManageableTeams('user-1'),
      requestApprovalTargets('user-1'),
      requestApprovalTargets('user-1'),
    ])

    assert.equal(requests.filter(url => url.includes('/manageable-teams')).length, 1)
    assert.equal(
      requests.filter(url => url.includes('/workflow-approval-mediums/targets')).length,
      1
    )

    await requestManageableTeams('user-1')
    await requestApprovalTargets('user-1')
    assert.equal(requests.length, 2)

    await Promise.all([
      requestManageableTeams('user-1', { force: true }),
      requestManageableTeams('user-1', { force: true }),
      requestApprovalTargets('user-1', { force: true }),
      requestApprovalTargets('user-1', { force: true }),
    ])
    assert.equal(requests.length, 4)
  } finally {
    globalThis.fetch = originalFetch
    resetProfileAccessCache()
  }
})
