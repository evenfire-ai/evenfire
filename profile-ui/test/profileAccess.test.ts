import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalChannelTarget } from '../app/types/approvalChannels'
import type { ManageableTeam } from '../app/types/profile'
import {
  readProfileAccessCache,
  requestApprovalTargets,
  requestManageableTeams,
  resetProfileAccessCache,
} from '../lib/profileAccess'
import {
  canManageMembersForAccess,
  profileAccessStateAfterApprovalTargetsError,
  profileAccessStateAfterManageableTeamsError,
  profileAccessStateForUser,
} from '../lib/profileAccessState'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

function team(id: string): ManageableTeam {
  return {
    id,
    name: id,
    role: 'admin',
    canAssignLeader: true,
  }
}

function target(id: string): ApprovalChannelTarget {
  return {
    id,
    medium: 'slack',
    agentName: 'agent-1',
    channelName: id,
    channelNamespace: 'default',
    botLabel: 'Slack App',
    botUsername: null,
    botDeepLink: null,
    status: 'ready',
  }
}

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

test('manageable-team requests cannot repopulate the live cache after a keyed reset', async () => {
  const originalFetch = globalThis.fetch
  const stale = deferred<Response>()
  const requests: string[] = []
  globalThis.fetch = (async input => {
    requests.push(String(input))
    if (requests.length === 1) return stale.promise
    return jsonResponse({ items: [team('fresh-team')] })
  }) as typeof fetch

  try {
    resetProfileAccessCache()
    const pending = requestManageableTeams('user-1')
    assert.equal(requests.filter(url => url.includes('/manageable-teams')).length, 1)

    resetProfileAccessCache('user-1')
    stale.resolve(jsonResponse({ items: [team('stale-team')] }))
    await pending

    assert.deepEqual(readProfileAccessCache('user-1').manageableTeams, undefined)
    assert.deepEqual(await requestManageableTeams('user-1'), [team('fresh-team')])
    assert.equal(requests.filter(url => url.includes('/manageable-teams')).length, 2)
  } finally {
    globalThis.fetch = originalFetch
    resetProfileAccessCache()
  }
})

test('approval-target requests cannot repopulate the live cache after a full reset', async () => {
  const originalFetch = globalThis.fetch
  const stale = deferred<Response>()
  const requests: string[] = []
  globalThis.fetch = (async input => {
    requests.push(String(input))
    if (requests.length === 1) return stale.promise
    return jsonResponse({ items: [target('fresh-target')] })
  }) as typeof fetch

  try {
    resetProfileAccessCache()
    const pending = requestApprovalTargets('user-1')
    assert.equal(
      requests.filter(url => url.includes('/workflow-approval-mediums/targets')).length,
      1
    )

    resetProfileAccessCache()
    stale.resolve(jsonResponse({ items: [target('stale-target')] }))
    await pending

    assert.deepEqual(readProfileAccessCache('user-1').approvalTargets, undefined)
    assert.deepEqual(await requestApprovalTargets('user-1'), [target('fresh-target')])
    assert.equal(
      requests.filter(url => url.includes('/workflow-approval-mediums/targets')).length,
      2
    )
  } finally {
    globalThis.fetch = originalFetch
    resetProfileAccessCache()
  }
})

test('profile access state initializes from valid cached data without loading', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async input => {
    const url = String(input)
    if (url.includes('/manageable-teams')) return jsonResponse({ items: [team('team-1')] })
    return jsonResponse({ items: [target('target-1')] })
  }) as typeof fetch

  try {
    resetProfileAccessCache()
    await requestManageableTeams('user-1')
    await requestApprovalTargets('user-1')

    assert.deepEqual(profileAccessStateForUser('user-1'), {
      approvalTargets: [target('target-1')],
      approvalTargetsError: false,
      approvalTargetsLoading: false,
      manageableTeams: [team('team-1')],
      manageableTeamsError: false,
      manageableTeamsLoading: false,
    })
  } finally {
    globalThis.fetch = originalFetch
    resetProfileAccessCache()
  }
})

test('profile access state is fail-closed for uncached and changed users', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => jsonResponse({ items: [team('team-1')] })) as typeof fetch

  try {
    resetProfileAccessCache()
    await requestManageableTeams('user-1')

    const nextUser = profileAccessStateForUser('user-2')
    assert.deepEqual(nextUser.manageableTeams, [])
    assert.equal(nextUser.manageableTeamsLoading, true)
    assert.deepEqual(nextUser.approvalTargets, [])
    assert.equal(nextUser.approvalTargetsLoading, true)
  } finally {
    globalThis.fetch = originalFetch
    resetProfileAccessCache()
  }
})

test('profile access authorization derives from role or manageable-team access', () => {
  assert.equal(canManageMembersForAccess('admin', []), true)
  assert.equal(canManageMembersForAccess('inviter', []), true)
  assert.equal(canManageMembersForAccess('member', [team('team-1')]), true)
  assert.equal(canManageMembersForAccess('member', []), false)
  assert.equal(canManageMembersForAccess(null, []), false)
})

test('profile access errors without prior data remain fail-closed', () => {
  const previous = {
    approvalTargets: [],
    approvalTargetsError: false,
    approvalTargetsLoading: true,
    manageableTeams: [],
    manageableTeamsError: false,
    manageableTeamsLoading: true,
  }

  assert.deepEqual(profileAccessStateAfterManageableTeamsError(previous), {
    ...previous,
    manageableTeamsError: true,
    manageableTeamsLoading: false,
  })
  assert.deepEqual(profileAccessStateAfterApprovalTargetsError(previous), {
    ...previous,
    approvalTargetsError: true,
    approvalTargetsLoading: false,
  })
})

test('profile access refresh errors preserve known access data', () => {
  const previous = {
    approvalTargets: [target('target-1')],
    approvalTargetsError: false,
    approvalTargetsLoading: false,
    manageableTeams: [team('team-1')],
    manageableTeamsError: false,
    manageableTeamsLoading: false,
  }

  assert.deepEqual(profileAccessStateAfterManageableTeamsError(previous), {
    ...previous,
    manageableTeamsError: true,
    manageableTeamsLoading: false,
  })
  assert.equal(
    canManageMembersForAccess(
      'member',
      profileAccessStateAfterManageableTeamsError(previous).manageableTeams
    ),
    true
  )
  assert.deepEqual(profileAccessStateAfterApprovalTargetsError(previous), {
    ...previous,
    approvalTargetsError: true,
    approvalTargetsLoading: false,
  })
})

test('profile access user changes clear previously preserved error-state access', () => {
  const previous = {
    approvalTargets: [target('target-1')],
    approvalTargetsError: false,
    approvalTargetsLoading: false,
    manageableTeams: [team('team-1')],
    manageableTeamsError: false,
    manageableTeamsLoading: false,
  }
  const errored = profileAccessStateAfterManageableTeamsError(previous)

  assert.deepEqual(errored.manageableTeams, [team('team-1')])
  const nextUser = profileAccessStateForUser('user-2')
  assert.deepEqual(nextUser.manageableTeams, [])
  assert.equal(nextUser.manageableTeamsLoading, true)
  assert.deepEqual(nextUser.approvalTargets, [])
  assert.equal(nextUser.approvalTargetsLoading, true)
})
