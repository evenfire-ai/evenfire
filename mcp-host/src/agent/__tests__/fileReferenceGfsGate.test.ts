/**
 * #666 — the per-message gate between the Host's GFS token and file
 * reference resolution.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GfsToolScopeInspection } from '../../internalTools/gfsClient'
import { createFileReferenceGfsGate } from '../fileReferenceGfsGate'
import type { FileReferenceGfscClient } from '../fileReferenceResolver'

function gate(inspection: GfsToolScopeInspection) {
  const client: FileReferenceGfscClient = { resolve: vi.fn() }
  const logger = { warn: vi.fn(), error: vi.fn() }
  const inspectScopes = vi.fn(() => inspection)
  const access = createFileReferenceGfsGate({ inspectScopes, client, logger })
  return { access, client, logger, inspectScopes }
}

describe('createFileReferenceGfsGate (#666)', () => {
  it('returns the client for a token with gfs.read, and logs nothing', () => {
    const { access, client, logger, inspectScopes } = gate({
      status: 'ok',
      scopes: new Set(['gfs.read']),
    })
    expect(access()).toEqual({ status: 'available', client })
    // Witness: the token was inspected for this message.
    expect(inspectScopes).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['no token', { status: 'not_configured' } as const, 'not_configured'],
    [
      'a scope outside the allowlist',
      { status: 'scope_outside_allowlist' } as const,
      'scope_outside_allowlist',
    ],
    [
      'gfs.write only',
      { status: 'ok', scopes: new Set(['gfs.write'] as const) } as const,
      'missing_gfs_read',
    ],
    ['no scopes', { status: 'ok', scopes: new Set<never>() } as const, 'missing_gfs_read'],
  ])('answers unsupported for %s and warns with reason %s', (_label, inspection, reason) => {
    const { access, logger } = gate(inspection)
    expect(access()).toEqual({ status: 'unsupported' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'file_reference_gfs_unavailable', reason },
      'Host runtime event'
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['token_unreadable', 'TokenReadError'],
    ['token_undecodable', 'TokenDecodeError'],
  ] as const)('refuses on %s with %s and logs an error', (status, errorClass) => {
    const { access, logger } = gate({ status })
    expect(access()).toEqual({ status: 'credentials_failed', errorClass })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'file_reference_gfs_unavailable', reason: status },
      'Host runtime event'
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
