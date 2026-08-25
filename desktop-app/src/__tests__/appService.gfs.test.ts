import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppService, legacyEncodedFile, migrateDesktopGfsUploadState } from '../appService.js'
import { config, getActiveEnvKey } from '../config.js'
import { DesktopUploadCapabilityError, normalizeUploadProductMaxBytes } from '../gfs/upload.js'

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
      listShares: ReturnType<typeof vi.fn>
      revokeShare: ReturnType<typeof vi.fn>
    }
    grantGfs: (
      resourceId: string,
      subjectKeys: string[],
      bits: string[],
      drive?: string,
      inherit?: boolean
    ) => Promise<void>
    createGfsShare: (resourceId: string, subjectKeys: string[], drive?: string) => Promise<void>
    listGfsShares: (resourceId: string, drive?: string) => Promise<unknown[]>
    revokeGfsShare: (shareId: string) => Promise<void>
  }
  service.sessionToken = 'session-token'
  service.gfsClient = {
    grant: vi.fn().mockResolvedValue(undefined),
    createShare: vi.fn().mockResolvedValue(undefined),
    listShares: vi.fn().mockResolvedValue([]),
    revokeShare: vi.fn().mockResolvedValue(undefined),
  }
  return service
}

describe('AppService GFS delegation subject boundary', () => {
  it('forwards share list and revoke through the in-memory session token only', async () => {
    const service = gfsService()
    const shareId = '22222222-2222-4222-8222-222222222222'

    await service.listGfsShares(RESOURCE_ID, 'main')
    await service.revokeGfsShare(shareId)

    expect(service.gfsClient.listShares).toHaveBeenCalledWith(
      { resourceId: RESOURCE_ID, drive: 'main' },
      'session-token'
    )
    expect(service.gfsClient.revokeShare).toHaveBeenCalledWith(shareId, 'session-token')
  })

  it('passes only user/team grant subjects as ONE bulk subjects[] array', async () => {
    const service = gfsService()

    await service.grantGfs(RESOURCE_ID, ['user:user-1', 'team:team-2'], ['read'], 'main')
    await service.createGfsShare(RESOURCE_ID, ['team:team-1', 'user:user-9'], 'main')

    expect(service.gfsClient.grant).toHaveBeenCalledTimes(1)
    expect(service.gfsClient.grant).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subjects: [
          { type: 'user', id: 'user-1' },
          { type: 'team', id: 'team-2' },
        ],
        permissions: ['read'],
      },
      'session-token'
    )
    expect(service.gfsClient.createShare).toHaveBeenCalledTimes(1)
    expect(service.gfsClient.createShare).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subjects: [
          { type: 'team', id: 'team-1' },
          { type: 'user', id: 'user-9' },
        ],
        permissions: ['read'],
        includeDescendants: true,
      },
      'session-token'
    )
  })

  it('passes a managed host grant subject with inherit to the user-plane GFS client', async () => {
    const service = gfsService()

    await service.grantGfs(RESOURCE_ID, ['host:1st:mcp-host/chatllm'], ['read'], 'main', true)

    expect(service.gfsClient.grant).toHaveBeenCalledWith(
      {
        resourceId: RESOURCE_ID,
        drive: 'main',
        subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
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

      await expect(service.grantGfs(RESOURCE_ID, [subjectKey], ['read'], 'main')).rejects.toThrow(
        'subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>'
      )
      await expect(service.createGfsShare(RESOURCE_ID, [subjectKey], 'main')).rejects.toThrow(
        'subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>'
      )

      expect(service.gfsClient.grant).not.toHaveBeenCalled()
      expect(service.gfsClient.createShare).not.toHaveBeenCalled()
    }
  )

  it('fails the whole bulk grant when ANY subject key in the array is reserved', async () => {
    const service = gfsService()

    // A single bad key must reject before any round-trip — never a partial write.
    await expect(
      service.grantGfs(RESOURCE_ID, ['user:user-1', 'operator:'], ['read'], 'main')
    ).rejects.toThrow('subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>')

    expect(service.gfsClient.grant).not.toHaveBeenCalled()
  })

  it('rejects the party-less legacy sentinel host key before calling the GFS client', async () => {
    const service = gfsService()

    // `host:mcp-host/standalone` has no 1st|3rd party prefix — the legacy
    // fleet-wide sentinel form stays rejected by the host grammar shape check.
    await expect(
      service.grantGfs(RESOURCE_ID, ['host:mcp-host/standalone'], ['read'], 'main')
    ).rejects.toThrow('host subject must be host:<party>:<ns>/<name>')
    await expect(
      service.createGfsShare(RESOURCE_ID, ['host:mcp-host/standalone'], 'main')
    ).rejects.toThrow('host subject must be host:<party>:<ns>/<name>')

    expect(service.gfsClient.grant).not.toHaveBeenCalled()
    expect(service.gfsClient.createShare).not.toHaveBeenCalled()
  })
})

function uploadSession(uploadId: string, drive = 'main') {
  return {
    uploadId,
    drive,
    operation: 'create' as const,
    expectedBytes: 4,
    partBytes: 4,
    partCount: 1,
    state: 'uploading' as const,
    contiguousBytes: 0,
    committedBytes: 0,
    committedPartCount: 0,
    activePartCount: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function canonicalExternalBaseUrl(): string {
  return new URL(config.externalRestApiBaseUrl).toString().replace(/\/+$/, '')
}

function scopedUploadRecord(
  uploadId: string,
  options: {
    ownerId?: string
    teamId?: string | null
    environmentKey?: string
    drive?: string
    authEpoch?: number
    status?: 'active' | 'paused' | 'failed' | 'suspended_auth'
  } = {}
) {
  const drive = options.drive ?? 'main'
  return {
    version: 2,
    uploadId,
    filePath: '/tmp/payload.bin',
    fileName: 'payload.bin',
    fileSize: 4,
    target: { operation: 'create' as const, parentRid: 'parent' },
    name: 'payload.bin',
    session: uploadSession(uploadId, drive),
    scope: {
      ownerId: options.ownerId ?? 'user-a',
      teamId: options.teamId ?? 'team-a',
      environmentKey: options.environmentKey ?? getActiveEnvKey(),
      baseUrl: canonicalExternalBaseUrl(),
      drive,
      authEpoch: options.authEpoch ?? 7,
    },
    status: options.status ?? 'active',
    updatedAt: new Date().toISOString(),
  }
}

type UploadScopeTestService = {
  sessionToken: string | null
  me: {
    id: string
    email: string
    name: null
    picture: null
    teamId: string | null
    teamName: string | null
    role: null
  } | null
  gfsAuthEpoch: number
  gfsDispatchBlocked: boolean
  gfsUploadJobs: Map<
    string,
    {
      job: unknown
      promise: Promise<unknown>
      scope: ReturnType<typeof scopedUploadRecord>['scope']
    }
  >
  gfsPendingUploadJobs: Set<{
    job: {
      snapshot: () => unknown
      suspendForAuth: () => Promise<void>
    }
    promise: Promise<unknown>
    scope: ReturnType<typeof scopedUploadRecord>['scope']
  }>
  gfsClient: {
    createResource: ReturnType<typeof vi.fn>
    replaceFile: ReturnType<typeof vi.fn>
  }
  desktopGfsUploadStatePath: () => Promise<string>
  startDesktopGfsUpload: ReturnType<typeof vi.fn>
  authClient: {
    passwordLogin: ReturnType<typeof vi.fn>
    googleLogin: ReturnType<typeof vi.fn>
  }
  tokenStore: {
    clearSessionToken: ReturnType<typeof vi.fn>
    setSessionToken: ReturnType<typeof vi.fn>
  }
  completePasswordLogin: (email: string, password: string) => ReturnType<AppService['googleLogin']>
  googleLogin: AppService['googleLogin']
  listGfsUploadSessions: AppService['listGfsUploadSessions']
  getGfsUploadSnapshot: AppService['getGfsUploadSnapshot']
  pauseGfsUpload: AppService['pauseGfsUpload']
  cancelGfsUpload: AppService['cancelGfsUpload']
  resumeGfsUpload: AppService['resumeGfsUpload']
  logout: AppService['logout']
  runScopedLegacyGfsUpload: <T>(
    scope: ReturnType<typeof scopedUploadRecord>['scope'],
    operation: (token: string, signal: AbortSignal) => Promise<T>
  ) => Promise<T>
  startGfsFileUpload: AppService['startGfsFileUpload']
  startGfsFileReplace: AppService['startGfsFileReplace']
}

function authenticatedUploadService(statePath: string): UploadScopeTestService {
  const service = new AppService() as unknown as UploadScopeTestService
  service.sessionToken = 'token-a'
  service.me = {
    id: 'user-a',
    email: 'a@example.test',
    name: null,
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: null,
  }
  service.gfsAuthEpoch = 7
  service.gfsDispatchBlocked = false
  ;(service as any).gfsScopeIdentity = {
    ownerId: service.me.id,
    teamId: service.me.teamId,
    environmentKey: getActiveEnvKey(),
    baseUrl: canonicalExternalBaseUrl(),
  }
  service.desktopGfsUploadStatePath = async () => statePath
  service.authClient = {
    passwordLogin: vi.fn(),
    googleLogin: vi.fn(),
  }
  service.tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  service.startDesktopGfsUpload = vi.fn()
  return service
}

describe('AppService GFS upload security scope', () => {
  it('falls back to the bounded legacy create path for a fresh start when v2 is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-legacy-start-fallback-'))
    try {
      const filePath = join(root, 'legacy.bin')
      await writeFile(filePath, Buffer.from('legacy payload'))
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      service.startDesktopGfsUpload.mockRejectedValue(
        new DesktopUploadCapabilityError('resumable uploads are disabled', {
          allowLegacyFallback: true,
        })
      )
      service.gfsClient = {
        createResource: vi.fn().mockResolvedValue({
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          rid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          gfsUri: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          drive: 'main',
          parentResourceId: 'parent-rid',
          name: 'legacy.bin',
          kind: 'file',
          path: '/legacy.bin',
          version: 1,
          bytes: 14,
        }),
        replaceFile: vi.fn(),
      }

      const result = await service.startGfsFileUpload('parent-rid', 'legacy.bin', filePath, 'main')

      expect(result).toMatchObject({
        state: 'completed',
        operation: 'create',
        resultResourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedBytes: 14,
      })
      expect(service.gfsClient.createResource).toHaveBeenCalledWith(
        expect.objectContaining({
          parentResourceId: 'parent-rid',
          name: 'legacy.bin',
          drive: 'main',
          kind: 'file',
          encodedData: Buffer.from('legacy payload').toString('base64'),
        }),
        'token-a',
        expect.any(AbortSignal)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails loudly without legacy fallback for malformed v2 capabilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-malformed-capability-'))
    try {
      const filePath = join(root, 'payload.bin')
      await writeFile(filePath, Buffer.from('payload'))
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      let malformed: unknown
      try {
        normalizeUploadProductMaxBytes(0)
      } catch (error) {
        malformed = error
      }
      expect(malformed).toBeInstanceOf(DesktopUploadCapabilityError)
      service.startDesktopGfsUpload.mockRejectedValue(malformed)
      service.gfsClient = {
        createResource: vi.fn(),
        replaceFile: vi.fn(),
      }

      await expect(
        service.startGfsFileUpload('parent-rid', 'payload.bin', filePath, 'main')
      ).rejects.toBe(malformed)
      expect(service.gfsClient.createResource).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects above the legacy limit before invoking the fallback request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-legacy-limit-fallback-'))
    try {
      const filePath = join(root, 'oversized-legacy.bin')
      await writeFile(filePath, Buffer.alloc(0))
      await truncate(filePath, 16 * 1024 * 1024 + 1)
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      service.startDesktopGfsUpload.mockRejectedValue(
        new DesktopUploadCapabilityError('resumable uploads are disabled', {
          allowLegacyFallback: true,
        })
      )
      service.gfsClient = {
        createResource: vi.fn(),
        replaceFile: vi.fn(),
      }

      await expect(
        service.startGfsFileUpload('parent-rid', 'oversized-legacy.bin', filePath, 'main')
      ).rejects.toThrow('legacy GFS is limited to 16 MiB')
      expect(service.gfsClient.createResource).not.toHaveBeenCalled()
      expect(service.gfsClient.replaceFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never falls back to a second legacy resource for an explicit resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-explicit-resume-no-fallback-'))
    try {
      const filePath = join(root, 'resume.bin')
      await writeFile(filePath, Buffer.from('resume payload'))
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      service.startDesktopGfsUpload.mockRejectedValue(
        new DesktopUploadCapabilityError('resumable uploads are disabled', {
          allowLegacyFallback: true,
        })
      )
      service.gfsClient = {
        createResource: vi.fn(),
        replaceFile: vi.fn(),
      }

      await expect(
        service.startGfsFileUpload('parent-rid', 'resume.bin', filePath, 'main', 'resume-upload-id')
      ).rejects.toBeInstanceOf(DesktopUploadCapabilityError)
      expect(service.gfsClient.createResource).not.toHaveBeenCalled()
      expect(service.gfsClient.replaceFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never falls back to a legacy replace for an explicit resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-explicit-replace-resume-no-fallback-'))
    try {
      const filePath = join(root, 'replace.bin')
      await writeFile(filePath, Buffer.from('replace payload'))
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      service.startDesktopGfsUpload.mockRejectedValue(
        new DesktopUploadCapabilityError('resumable uploads are disabled', {
          allowLegacyFallback: true,
        })
      )
      service.gfsClient = {
        createResource: vi.fn(),
        replaceFile: vi.fn(),
      }

      await expect(
        service.startGfsFileReplace(RESOURCE_ID, filePath, 'main', 3, 'replace-resume-upload-id')
      ).rejects.toBeInstanceOf(DesktopUploadCapabilityError)
      expect(service.gfsClient.replaceFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps existing upload controls and read state available during a transient team hop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-transient-controls-'))
    try {
      const statePath = join(root, 'gfs-upload-sessions.json')
      const record = scopedUploadRecord('92929292-9292-4292-8292-929292929292')
      await writeFile(statePath, JSON.stringify({ version: 2, records: [record], quarantined: [] }))
      const service = authenticatedUploadService(statePath) as UploadScopeTestService & {
        gfsTransientTeamHopDepth: number
      }
      const job = {
        snapshot: vi.fn(() => ({
          state: 'uploading',
          session: record.session,
          uploadedBytes: 0,
          totalBytes: record.fileSize,
        })),
        pause: vi.fn(async () => ({ ...record.session, state: 'paused' as const })),
        cancel: vi.fn(async () => undefined),
      }
      service.gfsTransientTeamHopDepth = 1
      service.gfsUploadJobs.set(record.uploadId, {
        job,
        promise: Promise.resolve(record.session),
        scope: record.scope,
      })

      await expect(service.getGfsUploadSnapshot(record.uploadId, 'main')).resolves.toMatchObject({
        state: 'uploading',
      })
      await service.pauseGfsUpload(record.uploadId, 'main')
      await service.cancelGfsUpload(record.uploadId, 'main')
      expect(job.pause).toHaveBeenCalledTimes(1)
      expect(job.cancel).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps a live persisted active record to the renderer uploading state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-snapshot-state-'))
    try {
      const statePath = join(root, 'gfs-upload-sessions.json')
      const record = scopedUploadRecord('93939393-9393-4393-8393-939393939393')
      await writeFile(statePath, JSON.stringify({ version: 2, records: [record], quarantined: [] }))
      const service = authenticatedUploadService(statePath)
      const job = {
        snapshot: vi.fn(() => ({
          state: 'uploading',
          session: record.session,
          uploadedBytes: record.session.committedBytes,
          totalBytes: record.fileSize,
        })),
        suspendForAuth: vi.fn(async () => undefined),
      }
      service.gfsPendingUploadJobs.add({
        job,
        promise: Promise.resolve(record.session),
        scope: record.scope,
      })

      await expect(service.getGfsUploadSnapshot(record.uploadId, 'main')).resolves.toMatchObject({
        state: 'uploading',
        uploadedBytes: 0,
        totalBytes: 4,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quarantines legacy unscoped state instead of restoring it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-state-migration-'))
    try {
      const statePath = join(root, 'gfs-upload-sessions.json')
      const legacy = {
        uploadId: '77777777-7777-4777-8777-777777777777',
        filePath: '/tmp/legacy.bin',
        fileName: 'legacy.bin',
        fileSize: 4,
        target: { operation: 'create', parentRid: 'parent' },
        name: 'legacy.bin',
        session: {
          ...uploadSession('77777777-7777-4777-8777-777777777777'),
          token: 'nested-legacy-token-must-not-survive',
        },
        token: 'legacy-token-must-not-survive',
      }
      await writeFile(statePath, JSON.stringify([legacy]))
      const service = authenticatedUploadService(statePath)

      await expect(service.listGfsUploadSessions('main')).resolves.toEqual([])
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as {
        version: number
        records: unknown[]
        quarantined: Array<{ uploadId: string; reason: string }>
      }
      expect(migrated.version).toBe(2)
      expect(migrated.records).toEqual([])
      expect(migrated.quarantined).toEqual([
        expect.objectContaining({ uploadId: legacy.uploadId, reason: 'legacy_unscoped' }),
      ])
      expect(await readFile(statePath, 'utf8')).not.toContain('token-must-not-survive')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quarantines malformed v2 scope records deterministically', () => {
    const malformed = scopedUploadRecord('78787878-7878-4787-8787-787878787878')
    malformed.scope.baseUrl = 'not-a-url'
    const migrated = migrateDesktopGfsUploadState({
      version: 2,
      records: [malformed],
      quarantined: [],
    })
    expect(migrated.state.records).toEqual([])
    expect(migrated.state.quarantined).toEqual([
      expect.objectContaining({ uploadId: malformed.uploadId, reason: 'invalid_scope' }),
    ])
  })

  it('canonicalizes valid v2 records and quarantine metadata without persisting extra token fields', () => {
    const record = {
      ...scopedUploadRecord('79797979-7979-4797-8797-797979797979'),
      token: 'top-level-token-must-not-survive',
    }
    record.session = {
      ...record.session,
      token: 'session-token-must-not-survive',
    } as typeof record.session
    const migrated = migrateDesktopGfsUploadState({
      version: 2,
      records: [record],
      quarantined: [
        {
          uploadId: 'legacy-id',
          reason: 'legacy_unscoped',
          quarantinedAt: new Date().toISOString(),
          token: 'quarantine-token-must-not-survive',
        },
      ],
    })

    expect(migrated.migrated).toBe(true)
    expect(JSON.stringify(migrated.state)).not.toContain('token-must-not-survive')
    expect(migrated.state.records).toHaveLength(1)
    expect(migrated.state.quarantined).toEqual([
      expect.objectContaining({ uploadId: 'legacy-id', reason: 'legacy_unscoped' }),
    ])
  })

  it('suspends only restart-orphaned active records and permits explicit resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-state-restart-active-'))
    try {
      const statePath = join(root, 'gfs-upload-sessions.json')
      const orphaned = scopedUploadRecord('80808080-8080-4080-8080-808080808080')
      const live = scopedUploadRecord('81818181-8181-4181-8181-818181818181')
      await writeFile(
        statePath,
        JSON.stringify({ version: 2, records: [orphaned, live], quarantined: [] })
      )
      const service = authenticatedUploadService(statePath)
      service.gfsUploadJobs.set(live.uploadId, {
        job: {},
        promise: Promise.resolve(live.session),
        scope: live.scope,
      })

      await expect(service.listGfsUploadSessions('main')).resolves.toEqual([
        expect.objectContaining({ uploadId: orphaned.uploadId, status: 'suspended_auth' }),
        expect.objectContaining({ uploadId: live.uploadId, status: 'active' }),
      ])
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as {
        records: Array<{ uploadId: string; status: string }>
      }
      expect(migrated.records).toEqual([
        expect.objectContaining({ uploadId: orphaned.uploadId, status: 'suspended_auth' }),
        expect.objectContaining({ uploadId: live.uploadId, status: 'active' }),
      ])

      service.startDesktopGfsUpload.mockResolvedValue({ ...orphaned.session, state: 'uploading' })
      await service.resumeGfsUpload(orphaned.uploadId, 'main')
      expect(service.startDesktopGfsUpload).toHaveBeenCalledWith(
        expect.objectContaining({ resumeUploadId: orphaned.uploadId, drive: 'main' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fences a producer-created pending job during an authentication boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-pending-auth-fence-'))
    const originalFetch = globalThis.fetch
    const fetchStarted = vi.fn()
    const abortObserved = vi.fn()
    try {
      const filePath = join(root, 'pending.bin')
      await writeFile(filePath, Buffer.from('pending upload'))
      globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
        fetchStarted()
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal
          const abort = () => {
            abortObserved()
            reject(signal?.reason ?? new Error('synthetic authentication fence'))
          }
          if (signal?.aborted) {
            abort()
            return
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
        throw new Error('unreachable pending capabilities request')
      }) as typeof fetch

      const service = new AppService() as unknown as {
        sessionToken: string | null
        me: UploadScopeTestService['me']
        gfsAuthEpoch: number
        gfsDispatchBlocked: boolean
        gfsScopeIdentity: Omit<
          ReturnType<typeof scopedUploadRecord>['scope'],
          'drive' | 'authEpoch'
        >
        gfsPendingUploadJobs: UploadScopeTestService['gfsPendingUploadJobs']
        desktopGfsUploadStatePath: () => Promise<string>
        startDesktopGfsUpload: (input: Record<string, unknown>) => Promise<unknown>
        suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      }
      service.sessionToken = 'token-a'
      service.me = {
        id: 'user-a',
        email: 'a@example.test',
        name: null,
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: null,
      }
      service.gfsAuthEpoch = 7
      service.gfsDispatchBlocked = false
      service.gfsScopeIdentity = {
        ownerId: 'user-a',
        teamId: 'team-a',
        environmentKey: getActiveEnvKey(),
        baseUrl: canonicalExternalBaseUrl(),
      }
      service.desktopGfsUploadStatePath = async () => join(root, 'gfs-upload-sessions.json')

      const start = service.startDesktopGfsUpload({
        filePath,
        name: 'pending.bin',
        drive: 'main',
        operation: 'create',
        parentRid: 'parent-rid',
      })
      const startOutcome = start.then(
        () => ({ kind: 'resolved' as const }),
        error => ({ kind: 'rejected' as const, error })
      )
      await vi.waitFor(() => expect(service.gfsPendingUploadJobs.size).toBe(1))
      await vi.waitFor(() => expect(fetchStarted).toHaveBeenCalledTimes(1))

      await service.suspendDesktopGfsUploadsForAuthBoundary()

      await expect(startOutcome).resolves.toMatchObject({ kind: 'rejected' })
      expect(abortObserved).toHaveBeenCalledTimes(1)
      expect(service.gfsPendingUploadJobs.size).toBe(0)
      expect(service.gfsDispatchBlocked).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fences A on logout, hides its record from B, and permits explicit resume only for exact A scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-state-scope-'))
    try {
      const statePath = join(root, 'gfs-upload-sessions.json')
      const exact = scopedUploadRecord('88888888-8888-4888-8888-888888888888')
      const otherEnvironment = scopedUploadRecord('89898989-8989-4898-8898-898989898989', {
        environmentKey: `${getActiveEnvKey()}-other`,
      })
      const otherDrive = scopedUploadRecord('90909090-9090-4090-8090-909090909090', {
        drive: 'archive',
      })
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          records: [exact, otherEnvironment, otherDrive],
          quarantined: [],
        })
      )
      const service = authenticatedUploadService(statePath)

      await expect(service.listGfsUploadSessions('main')).resolves.toEqual([
        expect.objectContaining({ uploadId: exact.uploadId, drive: 'main' }),
      ])
      await expect(service.listGfsUploadSessions('archive')).resolves.toEqual([
        expect.objectContaining({ uploadId: otherDrive.uploadId, drive: 'archive' }),
      ])

      await service.logout()
      const afterLogout = JSON.parse(await readFile(statePath, 'utf8')) as {
        records: Array<{ uploadId: string; status: string }>
      }
      expect(afterLogout.records.find(record => record.uploadId === exact.uploadId)?.status).toBe(
        'suspended_auth'
      )
      expect(service.sessionToken).toBeNull()
      expect(service.gfsDispatchBlocked).toBe(true)

      service.sessionToken = 'token-b'
      service.me = {
        id: 'user-b',
        email: 'b@example.test',
        name: null,
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: null,
      }
      service.gfsDispatchBlocked = false
      ;(service as any).gfsScopeIdentity = {
        ownerId: service.me.id,
        teamId: service.me.teamId,
        environmentKey: getActiveEnvKey(),
        baseUrl: canonicalExternalBaseUrl(),
      }
      await expect(service.listGfsUploadSessions('main')).resolves.toEqual([])
      await expect(service.resumeGfsUpload(exact.uploadId, 'main')).rejects.toThrow(
        'not available in the active security scope'
      )
      expect(service.startDesktopGfsUpload).not.toHaveBeenCalled()

      service.sessionToken = 'token-a-new'
      service.me = {
        id: 'user-a',
        email: 'a@example.test',
        name: null,
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: null,
      }
      service.gfsAuthEpoch += 1
      ;(service as any).gfsScopeIdentity = {
        ownerId: service.me.id,
        teamId: service.me.teamId,
        environmentKey: getActiveEnvKey(),
        baseUrl: canonicalExternalBaseUrl(),
      }
      service.startDesktopGfsUpload.mockResolvedValue({ ...exact.session, state: 'uploading' })
      await service.resumeGfsUpload(exact.uploadId, 'main')
      expect(service.startDesktopGfsUpload).toHaveBeenCalledWith(
        expect.objectContaining({ resumeUploadId: exact.uploadId, drive: 'main' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts and awaits an in-flight legacy fallback before logout clears A credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-legacy-auth-fence-'))
    try {
      const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
      const scope = scopedUploadRecord('91919191-9191-4191-8191-919191919191').scope
      let releaseAbort!: () => void
      const abortReleased = new Promise<void>(resolve => {
        releaseAbort = resolve
      })
      let sawAbort = false
      const pending = service.runScopedLegacyGfsUpload(scope, (token, signal) => {
        expect(token).toBe('token-a')
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true
            void abortReleased.then(() => reject(signal.reason))
          })
        })
      })
      const settled = pending.then(
        () => 'resolved',
        error => String(error instanceof Error ? error.message : error)
      )
      let logoutSettled = false
      const logout = service.logout().then(() => {
        logoutSettled = true
      })
      await vi.waitFor(() => expect(sawAbort).toBe(true))
      expect(logoutSettled).toBe(false)
      releaseAbort()
      await logout

      await expect(settled).resolves.toContain('authentication fence')
      expect(service.sessionToken).toBeNull()
      expect(service.tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['password', 'google'] as const)(
    'aborts and awaits A uploads before %s login installs B credentials',
    async loginKind => {
      const root = await mkdtemp(join(tmpdir(), `evenfire-gfs-${loginKind}-login-fence-`))
      try {
        const service = authenticatedUploadService(join(root, 'gfs-upload-sessions.json'))
        const scope = scopedUploadRecord('92929292-9292-4292-8292-929292929292').scope
        const nextMe = {
          id: 'user-b',
          email: 'b@example.test',
          name: null,
          picture: null,
          teamId: 'team-b',
          teamName: 'Team B',
          role: null,
        }
        service.authClient.passwordLogin.mockResolvedValue({ token: 'token-b', me: nextMe })
        service.authClient.googleLogin.mockResolvedValue({ token: 'token-b', me: nextMe })

        let releaseAbort!: () => void
        const abortReleased = new Promise<void>(resolve => {
          releaseAbort = resolve
        })
        let sawAbort = false
        const pending = service.runScopedLegacyGfsUpload(
          scope,
          (_token, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                sawAbort = true
                void abortReleased.then(() => reject(signal.reason))
              })
            })
        )
        const pendingOutcome = pending.then(
          () => 'resolved',
          error => String(error instanceof Error ? error.message : error)
        )
        let loginSettled = false
        const login = (
          loginKind === 'password'
            ? service.completePasswordLogin('b@example.test', 'password')
            : service.googleLogin('google-id-token')
        ).then(result => {
          loginSettled = true
          return result
        })

        await vi.waitFor(() => expect(sawAbort).toBe(true))
        expect(loginSettled).toBe(false)
        expect(service.sessionToken).toBe('token-a')
        expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
        releaseAbort()

        await expect(pendingOutcome).resolves.toContain('authentication fence')
        await expect(login).resolves.toEqual({ authenticated: true, me: nextMe })
        expect(service.sessionToken).toBe('token-b')
        expect(service.me).toEqual(nextMe)
        expect(service.gfsDispatchBlocked).toBe(false)
        expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
          'token-b',
          getActiveEnvKey()
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('legacy GFS descriptor safety', () => {
  it('rejects a symbolic-link upload path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-legacy-symlink-'))
    try {
      const target = join(root, 'target.bin')
      const link = join(root, 'link.bin')
      await writeFile(target, 'trusted')
      await symlink(target, link)
      await expect(legacyEncodedFile(link)).rejects.toThrow(/symbolic link/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a pathname swap after opening and never reads the replacement path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-legacy-swap-'))
    const selected = join(root, 'selected.bin')
    const originalMoved = join(root, 'original.bin')
    const replacement = join(root, 'replacement.bin')
    await writeFile(selected, 'trusted')
    await writeFile(replacement, 'replacement')
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      await rename(selected, originalMoved)
      await rename(replacement, selected)
      return handle
    })
    try {
      await expect(legacyEncodedFile(selected)).rejects.toThrow('changed while it was being opened')
    } finally {
      openSpy.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
