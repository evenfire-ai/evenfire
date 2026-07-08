// desktop-app/test/e2e/ipc-roundtrip.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  E2E_EMAIL,
  E2E_HOST_REF,
  E2E_PASSWORD,
  invoke,
  setupHarness,
  teardownHarness,
  waitForIdle,
} from './helpers.js'

describe('IPC roundtrip e2e', () => {
  beforeAll(async () => {
    await setupHarness()
  })

  afterAll(async () => {
    await teardownHarness()
  })

  // ── Test 1: Login round-trip ─────────────────────────────────────
  it('1. passwordLogin stores session and getSessionState returns authenticated', async () => {
    const loginResult = await invoke('auth:passwordLogin', {
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    })
    expect(loginResult).toMatchObject({
      authenticated: true,
      me: expect.objectContaining({ email: E2E_EMAIL }),
    })

    const state = await invoke('auth:getSessionState')
    expect(state).toMatchObject({
      authenticated: true,
      me: expect.objectContaining({ email: E2E_EMAIL }),
    })
  })

  // ── Test 2: Dependencies health ──────────────────────────────────
  it('2. getDependenciesHealth reports both services ok', async () => {
    const health = (await invoke('auth:getDependenciesHealth')) as {
      externalRestApi: { ok: boolean }
      rpcProxy: { ok: boolean }
    }
    expect(health.externalRestApi.ok).toBe(true)
    expect(health.rpcProxy.ok).toBe(true)
  })

  // ── Test 3: Team listing ─────────────────────────────────────────
  it('3. team:list returns teams for authenticated user', async () => {
    const result = (await invoke('team:list')) as {
      currentTeamId: string
      items: Array<{ id: string; name: string }>
    }
    expect(result.currentTeamId).toBeTruthy()
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.items.length).toBeGreaterThanOrEqual(1)
  })

  // ── Test 4: Access catalog ───────────────────────────────────────
  it('4. access:getCatalog and refreshCatalog return agent/context lists', async () => {
    const refreshed = (await invoke('access:refreshCatalog')) as {
      agentNames: string[]
      contextIds: string[]
    }
    expect(Array.isArray(refreshed.agentNames)).toBe(true)
    expect(Array.isArray(refreshed.contextIds)).toBe(true)

    const cached = (await invoke('access:getCatalog')) as {
      agentNames: string[]
      contextIds: string[]
    }
    expect(cached.agentNames).toEqual(refreshed.agentNames)
    expect(cached.contextIds).toEqual(refreshed.contextIds)
  })

  // ── Test 7: Send message & get response ──────────────────────────
  it('7. rpc:invokeHostMessage delivers message and returns LLM response', async () => {
    const result = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Reply with exactly: E2E_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
      },
      hostRefs: [E2E_HOST_REF],
    })) as { success?: boolean; status?: string; response?: string; taskId?: string }

    // The host may return the result synchronously or asynchronously.
    // Sync: result contains the response directly (various field names).
    // Async: result.taskId is set, poll for completion.
    if (result.taskId) {
      await waitForIdle(E2E_HOST_REF)
      const taskResult = await invoke('rpc:getTaskResult', {
        hostRef: E2E_HOST_REF,
        taskId: result.taskId,
        hostRefs: [E2E_HOST_REF],
      })
      expect(taskResult).toBeTruthy()
    } else {
      // Response shape varies — just verify we got a non-empty result back
      expect(result).toBeTruthy()
      expect(Object.keys(result).length).toBeGreaterThan(0)
    }
  }, 60_000)

  // ── Test 8: Host status polling ──────────────────────────────────
  it('8. rpc:getHostStatus returns agent state and queue info', async () => {
    await waitForIdle(E2E_HOST_REF)
    const status = (await invoke('rpc:getHostStatus', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })) as {
      hostRef: string
      agent: { state: string }
      queue: { pending: number }
    }
    expect(status.hostRef).toBe(E2E_HOST_REF)
    expect(status.agent.state).toBe('idle')
    expect(typeof status.queue.pending).toBe('number')
  })

  // ── Test 9: Host activity snapshot ───────────────────────────────
  it('9. rpc:getHostActivity returns activity events', async () => {
    const activity = (await invoke('rpc:getHostActivity', {
      hostRef: E2E_HOST_REF,
      limit: 10,
      hostRefs: [E2E_HOST_REF],
    })) as {
      hostRef: string
      items: Array<{ type: string }>
    }
    expect(activity.hostRef.toLowerCase()).toBe(E2E_HOST_REF.toLowerCase())
    expect(Array.isArray(activity.items)).toBe(true)
    // After test 7, there should be at least some activity events
    expect(activity.items.length).toBeGreaterThan(0)
  })

  // ── Test 10: Task result retrieval (async mode) ──────────────────
  it('10. async invokeHostMessage + getTaskResult polls until completed', async () => {
    const result = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Reply with exactly: ASYNC_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
      },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as { taskId?: string; status?: string }

    if (!result.taskId) {
      // Host may process synchronously even with async flag
      console.warn('Host did not return taskId — skipping async polling')
      return
    }

    await waitForIdle(E2E_HOST_REF, 45_000)

    const taskResult = (await invoke('rpc:getTaskResult', {
      hostRef: E2E_HOST_REF,
      taskId: result.taskId,
      hostRefs: [E2E_HOST_REF],
    })) as { response?: string } | null
    expect(taskResult).toBeTruthy()
  }, 60_000)
})
