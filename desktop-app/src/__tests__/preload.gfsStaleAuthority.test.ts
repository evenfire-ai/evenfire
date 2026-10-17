import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  clerum: null as unknown,
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  sendSync: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      electron.clerum = value
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    off: electron.off,
    sendSync: electron.sendSync,
  },
  webUtils: { getPathForFile: vi.fn() },
}))

let gfs: Record<string, (...args: unknown[]) => Promise<unknown>>
const staleAuthorityMarker = '__CLERUM_GFS_STALE_AUTHORITY_V1__:'

function encodedIpcMessage(message: string): string {
  return encodeURIComponent(JSON.stringify(message))
}

beforeAll(async () => {
  await import('../preload.js')
  gfs = (electron.clerum as { gfs: typeof gfs }).gfs
})

beforeEach(() => {
  electron.invoke.mockReset()
})

describe('GFS preload stale authority marker', () => {
  it('normalizes the internal main marker into a typed error with the original message', async () => {
    electron.invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'gfs:listChildren': Error: " +
          `${staleAuthorityMarker}stale:${encodedIpcMessage('401 Unauthorized')}`
      )
    )

    let caught: unknown
    try {
      await gfs.listChildren('folder')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      name: 'GfsStaleSessionAuthorityError',
      code: 'GFS_STALE_SESSION_AUTHORITY',
      message: '401 Unauthorized',
    })
    expect((caught as Error).message).not.toContain('__CLERUM_GFS_STALE_AUTHORITY_V1__')
  })

  it('preserves ordinary current-generation failures unchanged', async () => {
    const failure = new Error("Error invoking remote method 'gfs:listChildren': 401 Unauthorized")
    electron.invoke.mockRejectedValueOnce(failure)

    await expect(gfs.listChildren('folder')).rejects.toBe(failure)
  })

  it('does not normalize a marker without the Electron GFS error envelope', async () => {
    const failure = new Error(`${staleAuthorityMarker}401 Unauthorized`)
    electron.invoke.mockRejectedValueOnce(failure)

    await expect(gfs.listChildren('folder')).rejects.toBe(failure)
  })

  it('restores a current error that collides with the reserved marker as an ordinary failure', async () => {
    const originalMessage = `${staleAuthorityMarker}401 Unauthorized`
    electron.invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'gfs:listChildren': Error: " +
          `${staleAuthorityMarker}message:${encodedIpcMessage(originalMessage)}`
      )
    )

    await expect(gfs.listChildren('folder')).rejects.toMatchObject({
      name: 'Error',
      message: originalMessage,
    })
  })
})
