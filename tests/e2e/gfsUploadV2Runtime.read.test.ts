import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readGfsUploadProductMaxBytes } from './gfsUploadV2Runtime'

const { execFileMock, execFileSyncMock, kubectlContextMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  kubectlContextMock: vi.fn(() => 'clerum-test'),
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}))

vi.mock('./gfsFixtureCore', async importOriginal => ({
  ...(await importOriginal<typeof import('./gfsFixtureCore')>()),
  kubectlContext: kubectlContextMock,
}))

describe('readGfsUploadProductMaxBytes', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    kubectlContextMock.mockClear()
    execFileMock.mockImplementation(
      (_file: unknown, args: unknown[], _options: unknown, callback: Function) => {
        const isJson = args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
        callback(null, {
          stdout: isJson
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
})
