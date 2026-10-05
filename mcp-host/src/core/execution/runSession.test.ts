import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { type ExecutionResult, MAX_EXECUTION_TIMEOUT_MS } from './runExecution'
import {
  EXECUTION_RESULT_MAX_BYTES,
  EXECUTION_RESULT_UID_HEADER,
  ExecutionSession,
  ExecutionSessionError,
  ExecutionSessionOptions,
  startExecutionSession,
} from './runSession'

const POD_UID = '6f1f0d2c-3a4b-4c5d-8e9f-0a1b2c3d4e5f'
const OTHER_UID = '11111111-2222-4333-8444-555555555555'
const BINARY = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xff])

const sampleResult: ExecutionResult = {
  reason: 'exited',
  exitCode: 0,
  signal: null,
  truncated: false,
  stdout: BINARY.toString('base64'),
  stderr: Buffer.from('stderr-bytes').toString('base64'),
}

const sessions: ExecutionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function openSession(
  overrides: Partial<ExecutionSessionOptions> = {}
): Promise<ExecutionSession> {
  const session = await startExecutionSession({
    timeoutMs: 30_000,
    argv: ['/bin/true'],
    podUid: POD_UID,
    host: '127.0.0.1',
    port: 0,
    graceMs: 1_000,
    run: async () => sampleResult,
    ...overrides,
  })
  sessions.push(session)
  return session
}

const resultUrl = (session: ExecutionSession): string => `http://127.0.0.1:${session.port}/result`

function headersFor(uid?: string | null): Record<string, string> {
  return uid === null ? {} : { [EXECUTION_RESULT_UID_HEADER]: uid ?? POD_UID }
}

const get = (session: ExecutionSession, uid?: string | null): Promise<Response> =>
  fetch(resultUrl(session), { headers: headersFor(uid) })

const del = (session: ExecutionSession, uid?: string | null): Promise<Response> =>
  fetch(resultUrl(session), { method: 'DELETE', headers: headersFor(uid) })

async function waitForResult(session: ExecutionSession): Promise<Response> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await get(session)
    if (response.status !== 425) return response
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('result was never published')
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was never met')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('private execution result session', () => {
  it('answers 425 while running and then one bounded frame for the exact Pod UID', async () => {
    let release!: (result: ExecutionResult) => void
    const session = await openSession({
      run: () =>
        new Promise<ExecutionResult>(resolve => {
          release = resolve
        }),
    })

    const early = await get(session)
    expect(early.status).toBe(425)
    expect(await early.text()).toBe('')
    expect(early.headers.get(EXECUTION_RESULT_UID_HEADER)).toBe(POD_UID)

    release(sampleResult)
    const ready = await waitForResult(session)
    expect(ready.status).toBe(200)
    expect(ready.headers.get('content-type')).toBe('application/json')
    expect(ready.headers.get(EXECUTION_RESULT_UID_HEADER)).toBe(POD_UID)
    const body = await ready.text()
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(EXECUTION_RESULT_MAX_BYTES)
    const parsed = JSON.parse(body) as ExecutionResult
    expect(parsed).toEqual(sampleResult)
    expect(Buffer.from(parsed.stdout, 'base64')).toEqual(BINARY)
    expect(Buffer.from(parsed.stderr, 'base64').toString('utf8')).toBe('stderr-bytes')

    const again = await get(session)
    expect(again.status).toBe(200)
    expect(await again.text()).toBe(body)
  })

  it('serves nothing to a missing or foreign Pod UID', async () => {
    const session = await openSession()
    await waitForResult(session)

    for (const uid of [null, OTHER_UID, '']) {
      const response = await get(session, uid)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
      expect(response.headers.get(EXECUTION_RESULT_UID_HEADER)).toBeNull()
    }

    const deniedDelete = await del(session, OTHER_UID)
    expect(deniedDelete.status).toBe(404)
    expect(await deniedDelete.text()).toBe('')
    // A rejected DELETE must not clear the frame or close the listener.
    expect((await get(session)).status).toBe(200)
  })

  it('reserves the listener before the approved command starts', async () => {
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()))
    const address = probe.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    await new Promise<void>(resolve => probe.close(() => resolve()))

    let observed = 0
    const session = await openSession({
      port,
      run: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/result`, {
          headers: { [EXECUTION_RESULT_UID_HEADER]: POD_UID },
        })
        observed = response.status
        await response.text()
        return sampleResult
      },
    })

    expect((await waitForResult(session)).status).toBe(200)
    expect(observed).toBe(425)
  })

  it('clears the frame and closes the listener after an authorized DELETE', async () => {
    let closedCalls = 0
    const session = await openSession({
      onClosed: () => {
        closedCalls += 1
      },
    })
    await waitForResult(session)

    const response = await del(session)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get(EXECUTION_RESULT_UID_HEADER)).toBe(POD_UID)

    await waitUntil(() => closedCalls === 1)
    await expect(fetch(resultUrl(session))).rejects.toThrow()
  })

  it('ends the finite session when the executor never settles', async () => {
    let closedCalls = 0
    const session = await openSession({
      timeoutMs: 150,
      graceMs: 150,
      run: () => new Promise<ExecutionResult>(() => {}),
      onClosed: () => {
        closedCalls += 1
      },
    })

    expect((await get(session)).status).toBe(425)
    await waitUntil(() => closedCalls === 1)
    await expect(fetch(resultUrl(session))).rejects.toThrow()
  })

  it('closes an incomplete request and notifies once instead of waiting on its socket', async () => {
    let closedCalls = 0
    const session = await openSession({
      onClosed: () => {
        closedCalls += 1
      },
    })
    const socket = connect({ host: '127.0.0.1', port: session.port })
    let failure: string | undefined
    socket.on('error', error => {
      failure = (error as NodeJS.ErrnoException).code
    })
    try {
      await once(socket, 'connect')
      socket.write('GET /result HTTP/1.1\r\nHost: local\r\n')
      const gone = new Promise<void>(resolve => socket.once('close', () => resolve()))
      await Promise.all([session.close(), session.close(), gone])
      expect(closedCalls).toBe(1)
      expect(socket.destroyed).toBe(true)
      expect(failure === undefined || failure === 'ECONNRESET').toBe(true)
    } finally {
      socket.destroy()
    }
  })

  it('rejects an invalid session contract without reserving a listener', async () => {
    let ran = 0
    const invalid: Array<Partial<ExecutionSessionOptions>> = [
      { podUid: 'not-a-pod-uid' },
      { podUid: '' },
      { podUid: POD_UID.toUpperCase() },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { timeoutMs: MAX_EXECUTION_TIMEOUT_MS + 1 },
      { argv: [] },
      { argv: [''] },
      { argv: ['x\0y'] },
      { graceMs: -1 },
    ]
    for (const override of invalid) {
      const error = await startExecutionSession({
        timeoutMs: 1_000,
        argv: ['/bin/true'],
        podUid: POD_UID,
        host: '127.0.0.1',
        port: 0,
        run: async () => {
          ran += 1
          return sampleResult
        },
        ...override,
      }).then(
        async session => {
          await session.close()
          return null
        },
        (failure: unknown) => failure
      )
      expect(error).toBeInstanceOf(ExecutionSessionError)
      expect((error as ExecutionSessionError).code).toBe('invalid_session_contract')
    }
    expect(ran).toBe(0)
  })

  it('fails closed instead of sending an oversized frame', async () => {
    const session = await openSession({
      run: async () => ({ ...sampleResult, stdout: 'A'.repeat(200_000) }),
    })

    const response = await waitForResult(session)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')
    expect(response.headers.get(EXECUTION_RESULT_UID_HEADER)).toBe(POD_UID)
  })

  it('never writes result bytes to the launcher streams', async () => {
    const writes: string[] = []
    const intercept = () =>
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as unknown as typeof process.stdout.write
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    process.stdout.write = intercept()
    process.stderr.write = intercept()
    try {
      const session = await openSession()
      expect((await waitForResult(session)).status).toBe(200)
      await (await del(session)).text()
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(writes).toEqual([])
  })

  it('serves the real execution result of a local fixture', async () => {
    // The fixture self-terminates through its watchdog; runExecution does not
    // expose the child PID, so no PID is retained by this suite.
    const session = await openSession({
      argv: [
        process.execPath,
        '-e',
        'setTimeout(() => process.exit(9), 30_000); ' +
          "process.stdout.write(Buffer.from([1, 2, 255])); process.stderr.write('e'); process.exit(3)",
      ],
      run: undefined,
    })

    const response = await waitForResult(session)
    expect(response.status).toBe(200)
    const parsed = JSON.parse(await response.text()) as ExecutionResult
    expect(parsed).toMatchObject({
      reason: 'exited',
      exitCode: 3,
      signal: null,
      truncated: false,
    })
    expect([...Buffer.from(parsed.stdout, 'base64')]).toEqual([1, 2, 255])
    expect(Buffer.from(parsed.stderr, 'base64').toString('utf8')).toBe('e')
  })
})
