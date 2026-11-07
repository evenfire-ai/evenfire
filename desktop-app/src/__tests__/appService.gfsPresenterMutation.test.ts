import { describe, expect, it, vi } from 'vitest'
import { AppService, type FileExplorerMutationRequest } from '../appService.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

type PresenterDispatchService = {
  dispatchFileExplorerMutation(request: FileExplorerMutationRequest): Promise<unknown>
  sessionGeneration: number
  sessionToken: string | null
  me: { id: string } | null
  gfsDispatchBlocked: boolean
  nativeAuthEnvironmentCommitQueue: Promise<void>
  gfsClient: {
    renameResource: ReturnType<typeof vi.fn>
  }
}

function makeService(): PresenterDispatchService {
  const service = new AppService() as unknown as PresenterDispatchService
  service.sessionGeneration = 7
  service.sessionToken = 'session-at-generation-7'
  service.me = { id: 'user-1' }
  service.gfsDispatchBlocked = false
  service.nativeAuthEnvironmentCommitQueue = Promise.resolve()
  service.gfsClient.renameResource = vi.fn()
  return service
}

function renameRequest(sessionGeneration = 7): FileExplorerMutationRequest {
  return {
    operation: 'rename',
    target: {
      resourceId: '11111111-1111-4111-8111-111111111111',
      drive: 'main',
      gfsUri: 'gfs://main/11111111111141118111111111111111',
      kind: 'file',
      version: 4,
      name: 'original.txt',
      parentResourceId: '22222222-2222-4222-8222-222222222222',
      sessionGeneration,
    },
    requestedName: 'renamed.txt',
  }
}

describe('AppService generation-bound GFS presenter dispatch', () => {
  it('passes the exact row version to the existing Rename CAS owner', async () => {
    const service = makeService()
    service.gfsClient.renameResource.mockResolvedValue({
      resourceId: '11111111-1111-4111-8111-111111111111',
      version: 5,
    })

    await expect(service.dispatchFileExplorerMutation(renameRequest())).resolves.toEqual({
      resourceId: '11111111-1111-4111-8111-111111111111',
      version: 5,
    })
    expect(service.gfsClient.renameResource).toHaveBeenCalledOnce()
    expect(service.gfsClient.renameResource).toHaveBeenCalledWith(
      {
        resourceId: '11111111-1111-4111-8111-111111111111',
        drive: 'main',
        newName: 'renamed.txt',
        ifMatch: 4,
      },
      'session-at-generation-7'
    )
  })

  it('rejects a stale presenter before invoking any request under replacement authority', async () => {
    const service = makeService()
    const slot = deferred<void>()
    service.nativeAuthEnvironmentCommitQueue = slot.promise
    const pending = service.dispatchFileExplorerMutation(renameRequest())

    service.sessionGeneration = 8
    service.sessionToken = 'replacement-session-at-generation-8'
    slot.resolve()

    await expect(pending).rejects.toThrow('stale_session_generation')
    expect(service.gfsClient.renameResource).not.toHaveBeenCalled()
  })

  it('lets a request invoked first settle after a later local generation change', async () => {
    const service = makeService()
    const remote = deferred<{ resourceId: string; version: number }>()
    service.gfsClient.renameResource.mockReturnValue(remote.promise)

    const pending = service.dispatchFileExplorerMutation(renameRequest())
    await vi.waitFor(() => expect(service.gfsClient.renameResource).toHaveBeenCalledOnce())
    service.sessionGeneration = 8
    service.sessionToken = 'replacement-session-at-generation-8'
    remote.resolve({ resourceId: '11111111-1111-4111-8111-111111111111', version: 5 })

    await expect(pending).resolves.toEqual({
      resourceId: '11111111-1111-4111-8111-111111111111',
      version: 5,
    })
    expect(service.gfsClient.renameResource).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatch: 4 }),
      'session-at-generation-7'
    )
  })

  it('fails closed when the URI or exact target version does not match the receipt', async () => {
    const service = makeService()
    const invalid = renameRequest() as Extract<FileExplorerMutationRequest, { operation: 'rename' }>
    invalid.target.gfsUri = 'gfs://main/33333333333343338333333333333333'

    await expect(service.dispatchFileExplorerMutation(invalid)).rejects.toThrow(
      'invalid_sidebar_mutation_receipt'
    )
    expect(service.gfsClient.renameResource).not.toHaveBeenCalled()
  })
})
