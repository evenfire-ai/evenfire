import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'
import {
  type GfsDesktopOperatorLink,
  GfsDesktopOperatorLinkError,
  gfsDesktopOperatorLinkService,
} from '../services/gfsDesktopOperatorLinkService.js'

export type ExternalGfsUserAuthority = {
  kind: 'user-session'
  desktopUserId: string
  tokenSubject: string
  authGeneration?: number
}

export type ExternalGfsLinkedAdminAuthority = {
  kind: 'linked-admin'
  desktopUserId: string
  controlAdminId: string
  tokenSubject: string
  authoritySource: 'linked-admin'
  authGeneration?: number
  linkLineageId: string
  linkGeneration: number
  desktopUserGeneration: number
  controlAdminGeneration: number
}

export type ExternalGfsAuthority = ExternalGfsUserAuthority | ExternalGfsLinkedAdminAuthority

export class ExternalGfsAuthorityError extends Error {
  constructor(
    readonly status: 403 | 503,
    readonly code:
      | 'desktop_user_retired'
      | 'gfs_operator_link_invalid'
      | 'gfs_authority_unavailable',
    options?: { cause?: unknown }
  ) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExternalGfsAuthorityError'
  }
}

type AuthorityDependencies = {
  linkingEnabled: boolean
  resolveActiveLink(desktopUserId: string): Promise<GfsDesktopOperatorLink | null>
  /** Optional only for isolated tests; production always supplies this guard. */
  isDesktopUserActive?(desktopUserId: string): Promise<boolean>
}

// The production singleton always implements the lifecycle guard. The runtime
// structural check keeps isolated callers that provide the historic read-only
// link double from being misclassified as a database outage; it is not a
// production fallback for a failed lifecycle lookup (those still return 503).
const defaultDesktopUserLifecycleGuard =
  typeof (gfsDesktopOperatorLinkService as Partial<typeof gfsDesktopOperatorLinkService>)
    .isDesktopUserActive === 'function'
    ? (id: string) => gfsDesktopOperatorLinkService.isDesktopUserActive(id)
    : undefined

function userAuthority(desktopUserId: string, authGeneration?: number): ExternalGfsUserAuthority {
  return {
    kind: 'user-session',
    desktopUserId,
    tokenSubject: desktopUserId,
    ...(authGeneration === undefined ? {} : { authGeneration }),
  }
}

async function assertDesktopUserActive(
  desktopUserId: string,
  guard: AuthorityDependencies['isDesktopUserActive'] = defaultDesktopUserLifecycleGuard
): Promise<void> {
  if (!guard) return
  try {
    if (!(await guard(desktopUserId))) {
      throw new ExternalGfsAuthorityError(403, 'desktop_user_retired')
    }
  } catch (error) {
    if (error instanceof ExternalGfsAuthorityError) throw error
    throw new ExternalGfsAuthorityError(503, 'gfs_authority_unavailable', { cause: error })
  }
}

/**
 * User-plane token minting has no operator-link resolver mounted after it, so
 * it needs the same lifecycle check explicitly before signing a token.
 */
export async function assertExternalGfsUserActive(desktopUserId: string): Promise<void> {
  await assertDesktopUserActive(desktopUserId)
}

/**
 * Resolve the effective GFS authority for one authenticated Desktop user.
 *
 * A retired user is denied before the feature flag can select ordinary
 * user-session authority. The flag is otherwise checked before the persisted
 * link is read. An absent row means an ordinary user session, while any
 * malformed, conflicting, missing-admin, or inactive-admin row fails closed.
 */
export async function resolveExternalGfsAuthority(
  desktopUserId: string,
  dependencies: AuthorityDependencies = {
    linkingEnabled: config.desktopGfsOperatorLinkingEnabled === true,
    resolveActiveLink: id => gfsDesktopOperatorLinkService.resolveActiveLink(id),
    isDesktopUserActive: defaultDesktopUserLifecycleGuard,
  }
): Promise<ExternalGfsAuthority> {
  await assertDesktopUserActive(desktopUserId, dependencies.isDesktopUserActive)
  if (dependencies.linkingEnabled !== true) return userAuthority(desktopUserId)

  let link: GfsDesktopOperatorLink | null
  try {
    link = await dependencies.resolveActiveLink(desktopUserId)
  } catch (error) {
    if (error instanceof GfsDesktopOperatorLinkError && error.code !== 'resolution_failed') {
      throw new ExternalGfsAuthorityError(403, 'gfs_operator_link_invalid', { cause: error })
    }
    throw new ExternalGfsAuthorityError(503, 'gfs_authority_unavailable', { cause: error })
  }
  if (!link) return userAuthority(desktopUserId)

  if (
    link.desktopUserId !== desktopUserId ||
    link.source !== 'initial_setup' ||
    !link.lineageId ||
    link.generation === undefined ||
    link.desktopUserGeneration === undefined ||
    link.controlAdminGeneration === undefined
  ) {
    throw new ExternalGfsAuthorityError(403, 'gfs_operator_link_invalid')
  }
  return {
    kind: 'linked-admin',
    desktopUserId,
    controlAdminId: link.controlAdminId,
    tokenSubject: link.controlAdminId,
    authoritySource: 'linked-admin',
    authGeneration: link.controlAdminGeneration,
    linkLineageId: link.lineageId,
    linkGeneration: link.generation,
    desktopUserGeneration: link.desktopUserGeneration,
    controlAdminGeneration: link.controlAdminGeneration,
  }
}

export type RequestWithExternalGfsAuthority = Request & {
  gfsAuthority?: ExternalGfsAuthority
}

export async function attachExternalGfsAuthority(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const desktopUserId = (req as Request & { externalAuth?: { userId?: string } }).externalAuth
    ?.userId
  if (!desktopUserId) {
    res.status(401).json({ error: 'unauthenticated' })
    return
  }
  try {
    const authority = await resolveExternalGfsAuthority(desktopUserId)
    if (authority.kind === 'user-session') {
      const generation = (req as Request & { externalAuth?: { authGeneration?: number } })
        .externalAuth?.authGeneration
      if (generation !== undefined) authority.authGeneration = generation
    }
    ;(req as RequestWithExternalGfsAuthority).gfsAuthority = authority
    next()
  } catch (error) {
    if (error instanceof ExternalGfsAuthorityError) {
      res.status(error.status).json({ error: error.code })
      return
    }
    next(error)
  }
}

/** Session-plane guard for the user-only token endpoint. */
export async function attachExternalGfsUserLifecycle(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const desktopUserId = (req as Request & { externalAuth?: { userId?: string } }).externalAuth
    ?.userId
  if (!desktopUserId) {
    res.status(401).json({ error: 'unauthenticated' })
    return
  }
  try {
    await assertExternalGfsUserActive(desktopUserId)
    next()
  } catch (error) {
    if (error instanceof ExternalGfsAuthorityError) {
      res.status(error.status).json({ error: error.code })
      return
    }
    next(error)
  }
}
