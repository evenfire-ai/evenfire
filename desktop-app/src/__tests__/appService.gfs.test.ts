import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const RESOURCE_ID = '11111111-1111-1111-1111-111111111111'

function gfsService() {
  const service = new AppService() as unknown as {
    sessionToken: string | null
    gfsClient: {
      grant: ReturnType<typeof vi.fn>
      createShare: ReturnType<typeof vi.fn>
    }
    grantGfs: (
      resourceId: string,
      subjectKey: string,
      bits: string[],
      drive?: string,
      inherit?: boolean
    ) => Promise<void>
    createGfsShare: (resourceId: string, subjectKey: string, drive?: string) => Promise<void>
  }
  service.sessionToken = 'session-token'
  service.gfsClient = {
    grant: vi.fn().mockResolvedValue(undefined),
    createShare: vi.fn().mockResolvedValue(undefined),
  }
  return service
}

describe('AppService GFS delegation subject boundary', () => {
  it('passes only user/team grant subjects to the user-plane GFS client', async () => {
    const service = gfsService()

    await service.grantGfs(RESOURCE_ID, 'user:user-1', ['read'], 'main')
    await service.createGfsShare(RESOURCE_ID, 'team:team-1', 'main')

    expect(service.gfsClient.grant).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subject: { type: 'user', id: 'user-1' },
        permissions: ['read'],
      },
      'session-token'
    )
    expect(service.gfsClient.createShare).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subject: { type: 'team', id: 'team-1' },
        permissions: ['read'],
        includeDescendants: true,
      },
      'session-token'
    )
  })

  it('passes a managed host grant subject with inherit to the user-plane GFS client', async () => {
    const service = gfsService()

    await service.grantGfs(RESOURCE_ID, 'host:1st:mcp-host/chatllm', ['read'], 'main', true)

    expect(service.gfsClient.grant).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subject: { type: 'host', id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        inherit: true,
      },
      'session-token'
    )
  })

  it.each(['operator:', 'context:engineering'])(
    'rejects reserved subject %s before calling the user-plane GFS client',
    async subjectKey => {
      const service = gfsService()

      await expect(service.grantGfs(RESOURCE_ID, subjectKey, ['read'], 'main')).rejects.toThrow(
        'subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>'
      )
      await expect(service.createGfsShare(RESOURCE_ID, subjectKey, 'main')).rejects.toThrow(
        'subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>'
      )

      expect(service.gfsClient.grant).not.toHaveBeenCalled()
      expect(service.gfsClient.createShare).not.toHaveBeenCalled()
    }
  )

  it('rejects the party-less legacy sentinel host key before calling the GFS client', async () => {
    const service = gfsService()

    // `host:mcp-host/standalone` has no 1st|3rd party prefix — the legacy
    // fleet-wide sentinel form stays rejected by the host grammar shape check.
    await expect(
      service.grantGfs(RESOURCE_ID, 'host:mcp-host/standalone', ['read'], 'main')
    ).rejects.toThrow('host subject must be host:<party>:<ns>/<name>')
    await expect(
      service.createGfsShare(RESOURCE_ID, 'host:mcp-host/standalone', 'main')
    ).rejects.toThrow('host subject must be host:<party>:<ns>/<name>')

    expect(service.gfsClient.grant).not.toHaveBeenCalled()
    expect(service.gfsClient.createShare).not.toHaveBeenCalled()
  })
})
