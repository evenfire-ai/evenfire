import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { type ClientRequest, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXECUTION_INPUT_MAX_BYTES } from './receiveInput'
import {
  EXECUTION_INPUT_CONTENT_TYPE,
  EXECUTION_INPUT_TIMEOUT_MAX_MS,
  EXECUTION_INPUT_UID_HEADER,
  ReceiveSession,
  ReceiveSessionError,
  ReceiveSessionOptions,
  startReceiveSession,
} from './receiveSession'

const POD_UID = '7f1f0d2c-3a4b-4c5d-8e9f-0a1b2c3d4e5f'
const OTHER_UID = '22222222-3333-4444-8555-666666666666'
const BINARY = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xff, 0x0a])
const DIGEST = createHash('sha256').update(BINARY).digest('hex')

const sessions: ReceiveSession[] = []
const dirs: string[] = []
const openRequests: ClientRequest[] = []

afterEach(async () => {
  for (const request of openRequests.splice(0)) request.destroy()
  for (const session of sessions.splice(0)) await session.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function inputDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pr932-input-session-'))
  dirs.push(dir)
  return dir
}

async function openSession(
  overrides: Partial<ReceiveSessionOptions> = {}
): Promise<ReceiveSession> {
  const session = await startReceiveSession({
    bytes: BINARY.length,
    sha256: DIGEST,
    timeoutMs: 30_000,
    podUid: POD_UID,
    host: '127.0.0.1',
    port: 0,
    graceMs: 1_000,
    ...overrides,
  })
  sessions.push(session)
  return session
}

const baseUrl = (session: ReceiveSession): string => `http://127.0.0.1:${session.port}`

function uidHeaders(uid?: string | null): Record<string, string> {
  return uid === null ? {} : { [EXECUTION_INPUT_UID_HEADER]: uid ?? POD_UID }
}

const post = (session: ReceiveSession, body: Buffer, uid?: string | null): Promise<Response> =>
  fetch(`${baseUrl(session)}/input`, {
    method: 'POST',
    headers: { 'content-type': EXECUTION_INPUT_CONTENT_TYPE, ...uidHeaders(uid) },
    body: new Uint8Array(body),
  })

const ready = (session: ReceiveSession, uid?: string | null): Promise<Response> =>
  fetch(`${baseUrl(session)}/ready`, { headers: uidHeaders(uid) })

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was never met')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitForFile(dir: string): Promise<Buffer> {
  const target = join(dir, 'source')
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    try {
      return await readFile(target)
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  throw new Error('input file was never published')
}

/** The session end is observable as a refused connection. */
async function waitForListenerClose(session: ReceiveSession, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await fetch(`${baseUrl(session)}/ready`, { headers: uidHeaders() })
    } catch {
      return
    }
    if (Date.now() - started > timeoutMs) throw new Error('listener never closed')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('private execution input session', () => {
  it('accepts one authorized POST, streams it and publishes the exact file', async () => {
    const dir = await inputDir()
    let outcome = ''
    const session = await openSession({
      directory: dir,
      onSettled: settled => {
        outcome = settled
      },
    })

    expect((await ready(session)).status).toBe(204)
    const response = await post(session, BINARY)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get(EXECUTION_INPUT_UID_HEADER)).toBe(POD_UID)

    await waitUntil(() => outcome === 'received')
    expect(await waitForFile(dir)).toEqual(BINARY)
    expect((await stat(join(dir, 'source'))).mode & 0o777).toBe(0o444)
    expect(await readdir(dir)).toEqual(['source'])
  })

  it('never writes input bytes to the launcher streams', async () => {
    const dir = await inputDir()
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
      const session = await openSession({ directory: dir })
      expect((await post(session, BINARY)).status).toBe(204)
      await waitForFile(dir)
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(writes).toEqual([])
  })

  it('serves readiness only to the exact Pod UID', async () => {
    const session = await openSession()

    const accepted = await ready(session)
    expect(accepted.status).toBe(204)
    expect(await accepted.text()).toBe('')
    expect(accepted.headers.get(EXECUTION_INPUT_UID_HEADER)).toBe(POD_UID)

    for (const uid of [null, OTHER_UID, '']) {
      const denied = await ready(session, uid)
      expect(denied.status).toBe(404)
      expect(await denied.text()).toBe('')
      expect(denied.headers.get(EXECUTION_INPUT_UID_HEADER)).toBeNull()
    }
  })

  it('ignores a foreign UID without a file and without consuming the session', async () => {
    const dir = await inputDir()
    const session = await openSession({ directory: dir })

    const foreign = await post(session, BINARY, OTHER_UID)
    expect(foreign.status).toBe(404)
    expect(await foreign.text()).toBe('')
    expect(foreign.headers.get(EXECUTION_INPUT_UID_HEADER)).toBeNull()
    expect(await readdir(dir)).toEqual([])

    // The authorized sender still delivers exactly once.
    expect((await post(session, BINARY)).status).toBe(204)
    expect(await waitForFile(dir)).toEqual(BINARY)
  })

  it('rejects wrong length or digest with a fixed empty 400 and no file', async () => {
    const cases: Array<[Buffer, string]> = [
      [Buffer.concat([BINARY, Buffer.from([1])]), DIGEST],
      [BINARY.subarray(0, BINARY.length - 1), DIGEST],
      [BINARY, createHash('sha256').update('other bytes').digest('hex')],
    ]
    for (const [body, sha256] of cases) {
      const dir = await inputDir()
      let outcome = ''
      const session = await openSession({
        directory: dir,
        sha256,
        onSettled: settled => {
          outcome = settled
        },
      })

      const response = await post(session, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('')
      await waitUntil(() => outcome === 'rejected')
      expect(await readdir(dir)).toEqual([])

      // The consumed context rejects a replay instead of re-running anything.
      const replay = await post(session, BINARY)
      expect(replay.status).toBe(409)
      expect(await replay.text()).toBe('')
      await expect(ready(session)).resolves.toMatchObject({ status: 404 })
      expect(await readdir(dir)).toEqual([])
    }
  })

  it('rejects a wrong content type once and consumes the session', async () => {
    const dir = await inputDir()
    const session = await openSession({ directory: dir })

    const wrongType = await fetch(`${baseUrl(session)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...uidHeaders() },
      body: BINARY,
    })
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('')
    expect(await readdir(dir)).toEqual([])

    expect((await post(session, BINARY)).status).toBe(409)
    expect(await readdir(dir)).toEqual([])
  })

  it('ends a stalled transfer at the finite deadline and publishes no file', async () => {
    const dir = await inputDir()
    let outcome = ''
    const session = await openSession({
      directory: dir,
      timeoutMs: 200,
      graceMs: 200,
      onSettled: settled => {
        outcome = settled
      },
    })

    const stalled = httpRequest({
      host: '127.0.0.1',
      port: session.port,
      path: '/input',
      method: 'POST',
      headers: {
        'content-type': EXECUTION_INPUT_CONTENT_TYPE,
        [EXECUTION_INPUT_UID_HEADER]: POD_UID,
      },
    })
    openRequests.push(stalled)
    stalled.on('error', () => {})
    stalled.write(BINARY.subarray(0, 3))
    await waitUntil(() => outcome === 'rejected')

    expect(await readdir(dir)).toEqual([])
    await waitForListenerClose(session)
  })

  it('ends an idle session at the finite deadline', async () => {
    let outcome = ''
    const session = await openSession({
      timeoutMs: 150,
      graceMs: 150,
      onSettled: settled => {
        outcome = settled
      },
    })

    expect((await ready(session)).status).toBe(204)
    await waitUntil(() => outcome === 'rejected')
    await waitForListenerClose(session)
  })

  it('rejects an invalid session contract without reserving a listener', async () => {
    let received = 0
    const invalid: Array<Partial<ReceiveSessionOptions>> = [
      { podUid: 'not-a-pod-uid' },
      { podUid: '' },
      { podUid: POD_UID.toUpperCase() },
      { bytes: -1 },
      { bytes: 1.5 },
      { bytes: EXECUTION_INPUT_MAX_BYTES + 1 },
      { sha256: 'A'.repeat(64) },
      { sha256: 'a'.repeat(63) },
      { sha256: 'z'.repeat(64) },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { timeoutMs: EXECUTION_INPUT_TIMEOUT_MAX_MS + 1 },
      { graceMs: -1 },
      { directory: '' },
    ]
    for (const override of invalid) {
      const error = await startReceiveSession({
        bytes: BINARY.length,
        sha256: DIGEST,
        timeoutMs: 1_000,
        podUid: POD_UID,
        host: '127.0.0.1',
        port: 0,
        receive: async () => {
          received += 1
        },
        ...override,
      }).then(
        async session => {
          await session.close()
          return null
        },
        (failure: unknown) => failure
      )
      expect(error).toBeInstanceOf(ReceiveSessionError)
      expect((error as ReceiveSessionError).code).toBe('invalid_session_contract')
    }
    expect(received).toBe(0)
  })
})
