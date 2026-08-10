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
}

export type ExternalGfsLinkedAdminAuthority = {
  kind: 'linked-admin'
  desktopUserId: string
  controlAdminId: string
  tokenSubject: string
  authoritySource: 'linked-admin'
}

export type ExternalGfsAuthority = ExternalGfsUserAuthority | ExternalGfsLinkedAdminAuthority

export class ExternalGfsAuthorityError extends Error {
  constructor(
    readonly status: 403 | 503,
    readonly code: 'gfs_operator_link_invalid' | 'gfs_authority_unavailable',
    options?: { cause?: unknown }
  ) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExternalGfsAuthorityError'
  }
}

type AuthorityDependencies = {
  linkingEnabled: boolean
  resolveActiveLink(desktopUserId: string): Promise<GfsDesktopOperatorLink | null>
}

function userAuthority(desktopUserId: string): ExternalGfsUserAuthority {
  return { kind: 'user-session', desktopUserId, tokenSubject: desktopUserId }
}

/**
 * Resolve the effective GFS authority for one authenticated Desktop user.
 *
 * The feature flag is checked before the persisted link is read. A disabled or
 * missing flag therefore cannot elevate a request. An absent row means an
 * ordinary user session, while any malformed, conflicting, missing-admin, or
 * inactive-admin row fails closed instead of falling back to user authority.
 */
export async function resolveExternalGfsAuthority(
  desktopUserId: string,
  dependencies: AuthorityDependencies = {
    linkingEnabled: config.desktopGfsOperatorLinkingEnabled === true,
    resolveActiveLink: id => gfsDesktopOperatorLinkService.resolveActiveLink(id),
  }
): Promise<ExternalGfsAuthority> {
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

  if (link.desktopUserId !== desktopUserId || link.source !== 'initial_setup') {
    throw new ExternalGfsAuthorityError(403, 'gfs_operator_link_invalid')
  }
  return {
    kind: 'linked-admin',
    desktopUserId,
    controlAdminId: link.controlAdminId,
    tokenSubject: link.controlAdminId,
    authoritySource: 'linked-admin',
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
    ;(req as RequestWithExternalGfsAuthority).gfsAuthority =
      await resolveExternalGfsAuthority(desktopUserId)
    next()
  } catch (error) {
    if (error instanceof ExternalGfsAuthorityError) {
      res.status(error.status).json({ error: error.code })
      return
    }
    next(error)
  }
}
