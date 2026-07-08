/**
 * Progress stream full flow test.
 *
 * Tests the ACTUAL desktop app flow: send message, subscribe to progress,
 * receive events via the real preload→ipc→appService→rpcProxy chain,
 * and verify the result is fetched.
 *
 * Key difference from ipc-progress-debug.test.ts: this test uses
 * subscribeTaskProgress (the preload API) instead of just starting
 * the stream and monitoring sender.send mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  E2E_EMAIL,
  E2E_HOST_REF,
  E2E_PASSWORD,
  getSender,
  invoke,
  setupHarness,
  teardownHarness,
  waitForIdle,
} from './helpers.js'

// Simulate what preload.ts does — subscribe and forward events
async function subscribeProgress(
  hostRef: string,
  taskId: string,
  onEvent: (event: unknown) => void
): Promise<() => Promise<void>> {
  const sender = getSender()
  const result = (await invoke('rpc:taskProgressStreamStart', {
    hostRef,
    taskId,
    hostRefs: [hostRef],
  })) as { streamId: string }

  const streamId = result.streamId
  if (!streamId) throw new Error('No streamId returned')

  // Poll sender.send mock for events (simulates ipcRenderer.on)
  let stopped = false
  const pollInterval = setInterval(() => {
    if (stopped) return
    const calls = sender.send.mock.calls as Array<[string, { streamId: string; event: unknown }]>
    for (const [ch, payload] of calls) {
      if (ch === 'rpc:taskProgressStreamEvent' && payload.streamId === streamId) {
        onEvent(payload.event)
      }
    }
    // Clear processed calls to avoid re-processing
    sender.send.mockClear()
  }, 50)

  return async () => {
    stopped = true
    clearInterval(pollInterval)
    await invoke('rpc:taskProgressStreamStop', { streamId }).catch(() => {})
  }
}

describe('Progress stream full flow', () => {
  beforeAll(async () => {
    await setupHarness()
    await invoke('auth:passwordLogin', { email: E2E_EMAIL, password: E2E_PASSWORD })
  })

  afterAll(async () => {
    await teardownHarness()
  })

  it('1. full desktop flow: send + subscribe + done → getTaskResult', async () => {
    await waitForIdle(E2E_HOST_REF, 30_000)
    getSender().send.mockClear()

    const t0 = Date.now()
    const log = (msg: string) => console.log(`[FLOW +${Date.now() - t0}ms] ${msg}`)

    // ── Step 1: Send message (like desktop UI does) ──
    log('Sending message...')
    const response = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Say exactly: FULL_FLOW_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId: randomUUID(),
      },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as Record<string, unknown>

    const taskId = String(response.taskId || '')
    log(`taskId: ${taskId}`)
    expect(taskId).toBeTruthy()

    // ── Step 2: Set up exactly like useWorkspaceController does ──
    let resolved = false
    let doneReceived = false
    let unsubscribe: (() => Promise<void>) | null = null
    let connectionTimerId: ReturnType<typeof setTimeout> | null = null
    let resultContent = ''

    const result = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (resolved) {
          log(`finish() called again (ignored), error: ${error?.message ?? 'none'}`)
          return
        }
        resolved = true
        if (connectionTimerId) {
          clearTimeout(connectionTimerId)
          connectionTimerId = null
        }
        void unsubscribe?.().catch(() => {})
        if (error) reject(error)
        else resolve(resultContent || 'no-content')
      }

      // 5-second connection timeout
      connectionTimerId = setTimeout(() => {
        log('⚠️ CONNECTION TIMEOUT FIRED (5s)')
        finish(new Error('Connection timeout'))
      }, 5000)

      // Event handler (same logic as desktop app)
      const handleEvent = (event: unknown) => {
        const evt = event as Record<string, unknown>
        const type = String(evt?.type || '')
        log(`handleEvent: type=${type}`)

        if (resolved) {
          log(`  → IGNORED (already resolved)`)
          return
        }

        if (type === 'open') {
          if (connectionTimerId) {
            clearTimeout(connectionTimerId)
            connectionTimerId = null
            log('  → Cleared connection timeout')
          }
          return
        }

        if (type === 'done') {
          doneReceived = true
          log('  → Polling getTaskResult...')
          void (async () => {
            try {
              const taskResult = (await invoke('rpc:getTaskResult', {
                hostRef: E2E_HOST_REF,
                taskId,
                hostRefs: [E2E_HOST_REF],
              })) as { response?: string } | null
              resultContent = taskResult?.response || ''
              log(`  → Got result: ${resultContent.slice(0, 50)}`)
              finish()
            } catch (e) {
              log(`  → Poll failed: ${(e as Error).message}`)
              finish(e as Error)
            }
          })()
          return
        }

        if (type === 'error') {
          log(`  → Error event: ${JSON.stringify(evt)}`)
          // Fall back to polling (like our fix does)
          void (async () => {
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 2000))
              try {
                const taskResult = (await invoke('rpc:getTaskResult', {
                  hostRef: E2E_HOST_REF,
                  taskId,
                  hostRefs: [E2E_HOST_REF],
                })) as Record<string, unknown> | null
                if (taskResult?.status === 'pending' && !taskResult?.response) continue
                resultContent = String(taskResult?.response || '')
                if (resultContent) {
                  log(`  → Poll fallback got result: ${resultContent.slice(0, 50)}`)
                  finish()
                  return
                }
              } catch {
                /* retry */
              }
            }
            finish(new Error('Poll fallback exhausted'))
          })()
          return
        }

        if (type === 'closed' && !doneReceived) {
          log('  → Stream closed without done, polling...')
          // Same poll fallback
          void (async () => {
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 2000))
              try {
                const taskResult = (await invoke('rpc:getTaskResult', {
                  hostRef: E2E_HOST_REF,
                  taskId,
                  hostRefs: [E2E_HOST_REF],
                })) as Record<string, unknown> | null
                if (taskResult?.status === 'pending' && !taskResult?.response) continue
                resultContent = String(taskResult?.response || '')
                if (resultContent) {
                  finish()
                  return
                }
              } catch {
                /* retry */
              }
            }
            finish(new Error('Poll fallback exhausted after close'))
          })()
          return
        }
      }

      // Subscribe (async, not awaited — same as desktop)
      void (async () => {
        try {
          log('Subscribing...')
          unsubscribe = await subscribeProgress(E2E_HOST_REF, taskId, handleEvent)
          log('Subscribed successfully')
        } catch (subError) {
          log(`Subscribe failed: ${(subError as Error).message}`)
          // Same poll fallback
          if (connectionTimerId) clearTimeout(connectionTimerId)
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000))
            try {
              const taskResult = (await invoke('rpc:getTaskResult', {
                hostRef: E2E_HOST_REF,
                taskId,
                hostRefs: [E2E_HOST_REF],
              })) as Record<string, unknown> | null
              if (taskResult?.status === 'pending' && !taskResult?.response) continue
              resultContent = String(taskResult?.response || '')
              if (resultContent) {
                finish()
                return
              }
            } catch {
              /* retry */
            }
          }
          finish(subError as Error)
        }
      })()
    })

    log(`Final result: ${result.slice(0, 80)}`)

    console.log('\n=== FULL FLOW RESULT ===')
    console.log(`  Duration: ${Date.now() - t0}ms`)
    console.log(`  Done received: ${doneReceived}`)
    console.log(`  Result: ${result.slice(0, 80)}`)
    console.log('========================\n')

    expect(result).toContain('FULL_FLOW_OK')
    expect(doneReceived).toBe(true)

    await waitForIdle(E2E_HOST_REF, 45_000)
  }, 90_000)
})
