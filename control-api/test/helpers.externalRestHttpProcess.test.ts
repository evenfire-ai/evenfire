import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { boundedRequest, startExternalRestHttpProcess } from './helpers/externalRestHttpProcess.js'

const seams = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn() }))
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>()
  seams.spawn.mockImplementation(real.spawn)
  return { ...real, spawn: seams.spawn }
})
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  seams.access.mockImplementation(real.access)
  return { ...real, access: seams.access }
})
const config = {
  controlApiBaseUrl: 'http://127.0.0.1:43121/api/v1',
  controlApiServiceToken: 'synthetic-process-contract-token',
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
function fakeChild(output?: string, hang = false, exitEarly = false) {
  const child = new EventEmitter() as EventEmitter & Record<string, any>
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn((signal: string) => {
    if (!hang || signal === 'SIGKILL') child.emit('exit', signal === 'SIGKILL' ? 137 : 0)
    return true
  })
  seams.spawn.mockImplementationOnce(() => {
    queueMicrotask(() =>
      exitEarly
        ? child.emit('exit', 1)
        : output === undefined
          ? undefined
          : child.stdout.write(output + '\n')
    )
    return child
  })
  return child
}
describe('bounded External REST HTTP process ownership', () => {
  it('starts the real built app with allowlisted synthetic environment and closes it', async () => {
    const child = await startExternalRestHttpProcess(config)
    try {
      expect(
        (await boundedRequest(child.baseUrl).get('/api/v1/recovery-contract-missing')).status
      ).toBe(404)
      const env = seams.spawn.mock.calls[0][2].env
      expect(Object.keys(env).sort()).toEqual(
        [
          'NODE_ENV',
          'LOG_LEVEL',
          'EXTERNAL_REST_API_CORS_ORIGIN',
          'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
          'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
          'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
          'EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME',
          'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
          'EXTERNAL_REST_API_JWT_ISSUER',
          'EXTERNAL_REST_API_JWT_AUDIENCE',
          'EXTERNAL_REST_API_PUBLIC_BASE_URL',
          'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
        ].sort()
      )
      expect(env.NODE_ENV).toBe('test')
    } finally {
      await child.stop()
    }
    await child.stop()
  })
  it.each([
    'https://127.0.0.1:43121/api/v1',
    'http://example.invalid:43121/api/v1',
    'http://127.0.0.1:43121/api/v1?next=x',
  ])('rejects unowned destination %s before spawning', async controlApiBaseUrl => {
    await expect(startExternalRestHttpProcess({ ...config, controlApiBaseUrl })).rejects.toThrow(
      'task-owned loopback'
    )
    expect(seams.spawn).not.toHaveBeenCalled()
  })
  it('fails before spawning when the service build is absent', async () => {
    seams.access.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(startExternalRestHttpProcess(config)).rejects.toThrow('Build External REST')
    expect(seams.spawn).not.toHaveBeenCalled()
  })
  it('fails and cleans up malformed readiness', async () => {
    const child = fakeChild('http://example.invalid')
    await expect(startExternalRestHttpProcess(config)).rejects.toThrow(
      'Invalid recovery HTTP readiness'
    )
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('fails if the child exits before readiness', async () => {
    fakeChild(undefined, false, true)
    const pending = startExternalRestHttpProcess(config)
    await expect(pending).rejects.toThrow('exited before readiness')
  })
  it('bounds absent readiness and terminates the child', async () => {
    vi.useFakeTimers()
    seams.access.mockResolvedValueOnce(undefined)
    const child = fakeChild()
    const pending = expect(startExternalRestHttpProcess(config)).rejects.toThrow(
      'readiness exceeded 10 seconds'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('does not accept an unsuccessfully exited ready child as successful cleanup', async () => {
    const child = fakeChild('http://127.0.0.1:43122')
    const running = await startExternalRestHttpProcess(config)
    child.emit('exit', 1)
    await expect(running.stop()).rejects.toThrow('exited unsuccessfully')
  })
  it('kills a hung child after the shutdown deadline and reports failure', async () => {
    vi.useFakeTimers()
    seams.access.mockResolvedValueOnce(undefined)
    const child = fakeChild('http://127.0.0.1:43122', true)
    const running = await startExternalRestHttpProcess(config)
    const pending = expect(running.stop()).rejects.toThrow('shutdown exceeded 5 seconds')
    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
