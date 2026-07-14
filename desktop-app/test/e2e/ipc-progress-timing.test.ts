/**
 * Progress stream timing diagnostic test.
 *
 * Measures exactly when events arrive to identify timing issues.
 * This test simulates the desktop app's full flow including
 * subscription setup, event handling, and result polling.
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

describe('Progress stream timing', () => {
  beforeAll(async () => {
    await setupHarness()
    await invoke('auth:passwordLogin', { email: E2E_EMAIL, password: E2E_PASSWORD })
  })

  afterAll(async () => {
    await teardownHarness()
  })

  it('1. measures time from send to each progress event', async () => {
    await waitForIdle(E2E_HOST_REF, 30_000)

    const sender = getSender()
    sender.send.mockClear()

    const t0 = Date.now()
    const log = (msg: string) => console.log(`[TIMING +${Date.now() - t0}ms] ${msg}`)

    // Send message
    log('Sending message...')
    const msgResult = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Say exactly: TIMING_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId: randomUUID(),
      },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as { taskId?: string }

    log(`Got taskId: ${msgResult.taskId}`)
    expect(msgResult.taskId).toBeTruthy()

    // Subscribe to progress stream (simulating what the desktop app does)
    log('Subscribing to progress stream...')
    const streamResult = (await invoke('rpc:taskProgressStreamStart', {
      hostRef: E2E_HOST_REF,
      taskId: msgResult.taskId,
      hostRefs: [E2E_HOST_REF],
    })) as { streamId: string }

    log(`Got streamId: ${streamResult.streamId}`)

    // Wait for events and measure timing
    const events: Array<{ type: string; elapsed: number; data: unknown }> = []
    const startPolling = Date.now()

    while (Date.now() - startPolling < 60_000) {
      const calls = sender.send.mock.calls as Array<
        [string, { streamId: string; event: Record<string, unknown> }]
      >
      for (const [ch, payload] of calls) {
        if (ch === 'rpc:taskProgressStreamEvent' && payload.streamId === streamResult.streamId) {
          const evt = payload.event
          const evtType = String((evt as Record<string, unknown>).type || 'unknown')
          if (
            !events.some(e => e.type === evtType && JSON.stringify(e.data) === JSON.stringify(evt))
          ) {
            const elapsed = Date.now() - t0
            events.push({ type: evtType, elapsed, data: evt })
            log(`Event: ${evtType} (data: ${JSON.stringify(evt).slice(0, 100)})`)
          }
        }
      }

      const hasDone = events.some(e => e.type === 'done')
      const hasError = events.some(e => e.type === 'error')
      if (hasDone || hasError) break

      await new Promise(r => setTimeout(r, 200))
    }

    // Report timing
    console.log('\n=== PROGRESS STREAM TIMING REPORT ===')
    for (const evt of events) {
      console.log(`  +${evt.elapsed}ms: ${evt.type}`)
    }
    console.log('=====================================\n')

    // Verify we got open + done
    const types = events.map(e => e.type)
    expect(types).toContain('open')
    expect(types).toContain('done')

    // Verify "open" arrives before 5 seconds (the connection timeout)
    const openEvent = events.find(e => e.type === 'open')
    expect(openEvent).toBeDefined()
    console.log(`[TIMING] "open" arrived at +${openEvent!.elapsed}ms (must be < 5000ms)`)
    expect(openEvent!.elapsed).toBeLessThan(5000)

    // Cleanup
    try {
      await invoke('rpc:taskProgressStreamStop', { streamId: streamResult.streamId })
    } catch {
      /* ignore */
    }
    await waitForIdle(E2E_HOST_REF, 45_000)
  }, 90_000)

  it('2. simulates desktop app flow: concurrent send + subscribe + timeout', async () => {
    await waitForIdle(E2E_HOST_REF, 30_000)

    const sender = getSender()
    sender.send.mockClear()

    const t0 = Date.now()
    const log = (msg: string) => console.log(`[DESKTOP-SIM +${Date.now() - t0}ms] ${msg}`)

    // Phase 1: Send message (like desktop does)
    log('Phase 1: Sending message...')
    const msgResult = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Say exactly: DESKTOP_SIM_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId: randomUUID(),
      },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as { taskId?: string }

    const taskId = msgResult.taskId!
    log(`Got taskId: ${taskId}`)

    // Phase 2: Simulate the desktop app's Promise wrapper
    let resolved = false
    let doneReceived = false
    let connectionTimerId: ReturnType<typeof setTimeout> | null = null
    let gotResult = false

    const result = await new Promise<{ status: string; response?: string; events: string[] }>(
      (resolve, reject) => {
        const eventLog: string[] = []

        const finish = (error?: Error) => {
          if (resolved) return
          resolved = true
          if (connectionTimerId) clearTimeout(connectionTimerId)
          if (error) {
            log(`finish(error): ${error.message}`)
            resolve({ status: 'error', events: eventLog })
          } else {
            log('finish() — success')
            resolve({ status: 'ok', events: eventLog })
          }
        }

        // 5-second connection timeout (same as desktop app)
        connectionTimerId = setTimeout(() => {
          log('CONNECTION TIMEOUT FIRED (5s)')
          eventLog.push('timeout:5s')
          // Desktop app currently calls finish(error) here.
          // Our fix adds poll fallback. But does "open" arrive in time?
          finish(new Error('Progress stream connection timeout'))
        }, 5000)

        // Phase 3: Subscribe (async, just like desktop)
        void (async () => {
          try {
            log('Phase 3: Subscribing...')
            const streamResult = (await invoke('rpc:taskProgressStreamStart', {
              hostRef: E2E_HOST_REF,
              taskId,
              hostRefs: [E2E_HOST_REF],
            })) as { streamId: string }

            log(`Subscribed, streamId: ${streamResult.streamId}`)

            // Monitor events via sender mock
            const checkInterval = setInterval(() => {
              if (resolved) {
                clearInterval(checkInterval)
                return
              }

              const calls = sender.send.mock.calls as Array<
                [string, { streamId: string; event: Record<string, unknown> }]
              >
              for (const [ch, payload] of calls) {
                if (
                  ch === 'rpc:taskProgressStreamEvent' &&
                  payload.streamId === streamResult.streamId
                ) {
                  const evt = payload.event as Record<string, unknown>
                  const evtType = String(evt.type || 'unknown')

                  if (!eventLog.includes(`event:${evtType}`)) {
                    eventLog.push(`event:${evtType}`)
                    log(`Event received: ${evtType}`)

                    if (evtType === 'open') {
                      // Clear connection timeout!
                      if (connectionTimerId) {
                        clearTimeout(connectionTimerId)
                        connectionTimerId = null
                        log("Connection timeout cleared by 'open' event")
                      }
                    }

                    if (evtType === 'done') {
                      doneReceived = true
                      // Poll for result
                      void (async () => {
                        try {
                          const taskResult = (await invoke('rpc:getTaskResult', {
                            hostRef: E2E_HOST_REF,
                            taskId,
                            hostRefs: [E2E_HOST_REF],
                          })) as { response?: string } | null
                          gotResult = true
                          log(`Got result: ${taskResult?.response?.slice(0, 50)}`)
                          clearInterval(checkInterval)
                          finish()
                        } catch (e) {
                          log(`Poll failed: ${(e as Error).message}`)
                          clearInterval(checkInterval)
                          finish(e as Error)
                        }
                      })()
                    }

                    if (evtType === 'error') {
                      log(`Error event: ${JSON.stringify(evt)}`)
                    }
                  }
                }
              }
            }, 100)
          } catch (subError) {
            log(`Subscribe threw: ${(subError as Error).message}`)
            finish(subError as Error)
          }
        })()
      }
    )

    console.log('\n=== DESKTOP SIMULATION RESULT ===')
    console.log(`  Status: ${result.status}`)
    console.log(`  Events: ${result.events.join(', ')}`)
    console.log(`  Done received: ${doneReceived}`)
    console.log(`  Got result: ${gotResult}`)
    console.log(`  Total time: ${Date.now() - t0}ms`)
    console.log('=================================\n')

    // The test passes if we got the result within 45 seconds
    // WITHOUT hitting the 5-second timeout
    expect(result.status).toBe('ok')
    expect(result.events).toContain('event:open')
    expect(result.events).toContain('event:done')
    expect(result.events).not.toContain('timeout:5s')

    await waitForIdle(E2E_HOST_REF, 45_000)
  }, 90_000)

  it('3. verifies open event clears timeout before 5s', async () => {
    await waitForIdle(E2E_HOST_REF, 30_000)

    const sender = getSender()
    sender.send.mockClear()

    const t0 = Date.now()

    // Send message
    const msgResult = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: {
        content: 'Say exactly: OPEN_TIMING_OK',
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId: randomUUID(),
      },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as { taskId?: string }

    // Subscribe immediately
    const streamResult = (await invoke('rpc:taskProgressStreamStart', {
      hostRef: E2E_HOST_REF,
      taskId: msgResult.taskId,
      hostRefs: [E2E_HOST_REF],
    })) as { streamId: string }

    // Wait for "open" event specifically
    let openElapsed = -1
    const start = Date.now()

    while (Date.now() - start < 10_000) {
      const calls = sender.send.mock.calls as Array<
        [string, { streamId: string; event: Record<string, unknown> }]
      >
      for (const [ch, payload] of calls) {
        if (
          ch === 'rpc:taskProgressStreamEvent' &&
          payload.streamId === streamResult.streamId &&
          (payload.event as Record<string, unknown>).type === 'open'
        ) {
          openElapsed = Date.now() - t0
          break
        }
      }
      if (openElapsed >= 0) break
      await new Promise(r => setTimeout(r, 50))
    }

    console.log(`[TIMING] "open" event arrived at +${openElapsed}ms after message send`)

    // "open" must arrive in less than 5 seconds (the connection timeout)
    expect(openElapsed).toBeGreaterThan(0)
    expect(openElapsed).toBeLessThan(5000)

    // Cleanup
    try {
      await invoke('rpc:taskProgressStreamStop', { streamId: streamResult.streamId })
    } catch {
      /* ignore */
    }
    await waitForIdle(E2E_HOST_REF, 45_000)
  }, 90_000)
})
