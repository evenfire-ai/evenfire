import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticateAdminSession } from '../src/services/adminSessionAuth.js'

const adminTokenMock = vi.hoisted(() => ({
  verifyAdminToken: vi.fn(),
}))

const adminSvcMock = vi.hoisted(() => ({
  findAdminById: vi.fn(),
  isAdminTokenRevoked: vi.fn(),
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => adminTokenMock)
vi.mock('../src/services/adminAuthService.js', () => adminSvcMock)

const BASE_CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: 9999999999,
  sessionVersion: 2,
}

const ACTIVE_ADMIN = {
  id: BASE_CLAIMS.sub,
  username: 'admin',
  email: 'admin@example.com',
  passwordHash: 'hash',
  sessionVersion: 2,
  role: 'admin' as const,
  status: 'active' as const,
  failedAttempts: 0,
  lockedUntil: null,
}

describe('services/adminSessionAuth', () => {
  beforeEach(() => {
    adminTokenMock.verifyAdminToken.mockReset()
    adminSvcMock.findAdminById.mockReset()
    adminSvcMock.isAdminTokenRevoked.mockReset()
  })

  it('accepts a valid administrator session with matching sessionVersion', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue(ACTIVE_ADMIN)

    await expect(authenticateAdminSession('valid-token')).resolves.toEqual(BASE_CLAIMS)
  })

  it('rejects missing or oversized tokens without calling downstream services', async () => {
    await expect(authenticateAdminSession(null)).resolves.toBeNull()
    await expect(authenticateAdminSession('')).resolves.toBeNull()
    await expect(authenticateAdminSession('x'.repeat(4097))).resolves.toBeNull()
    expect(adminTokenMock.verifyAdminToken).not.toHaveBeenCalled()
  })

  it('rejects invalid JWTs', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(null)
    await expect(authenticateAdminSession('bad-token')).resolves.toBeNull()
    expect(adminSvcMock.isAdminTokenRevoked).not.toHaveBeenCalled()
  })

  it('rejects revoked JTIs', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(true)

    await expect(authenticateAdminSession('valid-token')).resolves.toBeNull()
    expect(adminSvcMock.findAdminById).not.toHaveBeenCalled()
  })

  it('rejects tokens issued before password reset (stale sessionVersion)', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({ ...BASE_CLAIMS, sessionVersion: 1 })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({ ...ACTIVE_ADMIN, sessionVersion: 2 })

    await expect(authenticateAdminSession('stale-token')).resolves.toBeNull()
  })

  it('rejects tokens when sessionVersion claim exceeds the current admin record', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({ ...BASE_CLAIMS, sessionVersion: 3 })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({ ...ACTIVE_ADMIN, sessionVersion: 2 })

    await expect(authenticateAdminSession('future-token')).resolves.toBeNull()
  })

  it('treats absent sessionVersion claims as version 0', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({
      ...BASE_CLAIMS,
      sessionVersion: undefined,
    })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({ ...ACTIVE_ADMIN, sessionVersion: 0 })

    await expect(authenticateAdminSession('legacy-token')).resolves.toEqual({
      ...BASE_CLAIMS,
      sessionVersion: undefined,
    })
  })

  it('rejects disabled administrators', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({ ...ACTIVE_ADMIN, status: 'disabled' })

    await expect(authenticateAdminSession('valid-token')).resolves.toBeNull()
  })

  it('rejects missing administrator records', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue(null)

    await expect(authenticateAdminSession('valid-token')).resolves.toBeNull()
  })

  it('allows locked administrators because lockedUntil is login-only (F4 out of scope)', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      ...ACTIVE_ADMIN,
      lockedUntil: new Date(Date.now() + 60_000),
    })

    await expect(authenticateAdminSession('valid-token')).resolves.toEqual(BASE_CLAIMS)
  })

  it('propagates revocation lookup failures instead of mapping them to unauthorized', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockRejectedValue(new Error('pg connection terminated'))

    await expect(authenticateAdminSession('valid-token')).rejects.toThrow(
      'pg connection terminated'
    )
  })

  it('propagates findAdminById failures instead of mapping them to unauthorized', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockRejectedValue(new Error('pg connection terminated'))

    await expect(authenticateAdminSession('valid-token')).rejects.toThrow(
      'pg connection terminated'
    )
  })
})
