import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiGet } from '@lib/api'
import { createGfsUploadJob } from '@lib/gfsFileUpload'
import { GfsBrowser } from '../GfsBrowser'
import { ToastProvider } from '../Toast'

vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  apiGet: vi.fn(),
  apiSend: vi.fn(),
}))

vi.mock('@lib/gfsFileUpload', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/gfsFileUpload')>()),
  createGfsUploadJob: vi.fn(),
}))

const mockApiGet = vi.mocked(apiGet)
const mockCreateGfsUploadJob = vi.mocked(createGfsUploadJob)

describe('GfsBrowser Upload v2 conflict retry — T3 historical reproduction', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue({
      rootResourceId: '11111111-1111-1111-1111-111111111111',
      items: [],
      nextCursor: null,
    })
    mockCreateGfsUploadJob.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries the producer-backed structured 409 with the next observable file name', async () => {
    const actualUpload =
      await vi.importActual<typeof import('@lib/gfsFileUpload')>('@lib/gfsFileUpload')
    const producerErrors: unknown[] = []
    const uploadNames: string[] = []
    const session = {
      uploadId: 'producer-upload',
      drive: 'main',
      operation: 'create' as const,
      expectedBytes: 0,
      partBytes: 1,
      partCount: 0,
      state: 'initiated',
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/gfs/proxy/v1/capabilities')) {
        return new Response(
          JSON.stringify({
            upload: {
              resumableV2: {
                enabled: true,
                maxFileBytes: 1024 * 1024 * 1024,
                preferredChunkBytes: 1,
                maxChunkBytes: 1,
              },
            },
          }),
          { status: 200 }
        )
      }
      if (method === 'POST' && url.endsWith('/api/v1/gfs/proxy/v1/uploads')) {
        const body = JSON.parse(String(init?.body)) as { name: string }
        uploadNames.push(body.name)
        if (uploadNames.length === 1) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'conflict', message: 'resource already exists' },
            }),
            { status: 409, statusText: 'Conflict' }
          )
        }
        return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
      }
      if (
        method === 'POST' &&
        url.endsWith(`/api/v1/gfs/proxy/v1/uploads/${session.uploadId}/complete`)
      ) {
        return new Response(
          JSON.stringify({ ok: true, data: { ...session, state: 'completed' } }),
          { status: 200 }
        )
      }
      throw new Error(`Unexpected producer request: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    mockCreateGfsUploadJob.mockImplementation(input => {
      const job = actualUpload.createGfsUploadJob(input)
      return {
        start: async () => {
          try {
            return await job.start()
          } catch (error) {
            producerErrors.push(error)
            throw error
          }
        },
        pause: job.pause.bind(job),
        resume: job.resume.bind(job),
        cancel: job.cancel.bind(job),
        snapshot: job.snapshot.bind(job),
      }
    })

    render(
      <ToastProvider>
        <GfsBrowser />
      </ToastProvider>
    )
    await screen.findByText('No resources are visible in this folder.')

    fireEvent.click(screen.getByRole('button', { name: /upload file/i }))
    const uploadDialog = await screen.findByRole('dialog', { name: 'Upload file' })
    fireEvent.change(within(uploadDialog).getByLabelText('Choose file to upload'), {
      target: { files: [new File([], 'report.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Upload' }))

    await waitFor(() => {
      expect(uploadNames).toEqual(['report.txt', 'report (1).txt'])
    })
    const conflict = producerErrors[0] as Error & { status?: number; code?: string }
    expect(conflict).toBeInstanceOf(Error)
    expect(conflict.message).toBe('409 resource already exists')
    expect(conflict.status).toBe(409)
    expect(conflict.code).toBe('conflict')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload file' })).toBeNull())
  })
})
