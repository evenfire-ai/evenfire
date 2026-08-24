import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readGfsUploadProductMaxBytes, recoverGfsUploadProductMaxBytes } from './gfsUploadV2Runtime'

const { execFileMock, execFileSyncMock, kubectlContextMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  kubectlContextMock: vi.fn(() => 'clerum-test'),
  spawnMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}))

vi.mock('./gfsFixtureCore', async importOriginal => ({
  ...(await importOriginal<typeof import('./gfsFixtureCore')>()),
  kubectlContext: kubectlContextMock,
}))

describe('readGfsUploadProductMaxBytes', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    kubectlContextMock.mockClear()
    execFileMock.mockImplementation(
      (_file: unknown, args: unknown[], _options: unknown, callback: Function) => {
        const isJson = args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
        const isRecoveryMarker = args.includes('configmap/gfs-upload-product-limit-recovery')
        callback(null, {
          stdout: isRecoveryMarker
            ? ''
            : isJson
              ? JSON.stringify({ spec: { template: { spec: { containers: [{ env: [] }] } } } })
              : '',
          stderr: '',
        })
      }
    )
  })

  it('represents an absent rendered writer env without treating it as malformed', async () => {
    await expect(readGfsUploadProductMaxBytes()).resolves.toEqual({ kind: 'absent' })
    expect(execFileMock).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['-o', 'json']),
      expect.anything(),
      expect.any(Function)
    )
  })

  it('reports no interrupted transaction when the durable marker is absent', async () => {
    await expect(
      recoverGfsUploadProductMaxBytes({ uid: 'expected-uid', holder: 'expected-holder' })
    ).resolves.toBe(false)
    expect(execFileMock).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['configmap/gfs-upload-product-limit-recovery', '--ignore-not-found']),
      expect.anything(),
      expect.any(Function)
    )
  })

  it('fails closed when the cluster recovery marker is not immutable', async () => {
    execFileMock.mockImplementationOnce(
      (_file: unknown, _args: unknown[], _options: unknown, callback: Function) => {
        callback(null, {
          stdout: JSON.stringify({
            metadata: { uid: 'marker-uid' },
            immutable: false,
            data: { 'transaction.json': '{}' },
          }),
          stderr: '',
        })
      }
    )

    await expect(
      recoverGfsUploadProductMaxBytes({ uid: 'expected-uid', holder: 'expected-holder' })
    ).rejects.toThrow('invalid GFS Upload v2 product-limit recovery ConfigMap shape')
  })
})
