import type { NextFunction, Request, Response } from 'express'
import {
  type FilesystemActionAuthorityV2,
  type GfsPathBinding,
  type GfsScope,
  signGfsToken,
} from '../auth/gfsToken.js'
import { config } from '../config.js'
import { withTransaction } from '../db.js'
import type { ExternalSessionAuthentication } from '../services/auth/externalSessionAuthentication.js'
import {
  externalSessionDatabaseFailure,
  isExternalSessionBackendUnavailableError,
} from '../services/auth/sessionDatabaseFailure.js'
import { validateExternalSessionAuthorityContext } from '../services/auth/userSessionService.js'
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

type AuthenticatedExternalSession = Extract<
  ExternalSessionAuthentication,
  { status: 'authenticated' }
>

export type ExternalGfsUserTokenInput = Readonly<{
  subject: string
  drive: string
  scopes: readonly GfsScope[]
  pathBindings?: readonly GfsPathBinding[]
  actionAuthority?: FilesystemActionAuthorityV2
}>

/**
 * Sign a user-plane GFS token while the authenticated session and canonical
 * user generation are current under the same principal lock. GFSC consumes
 * users.lifecycle_version as authGeneration; V2's sessionVersion is a
 * different fence and must never be projected into that claim.
 *
 * The signed bytes remain private to this function until COMMIT succeeds, so a
 * lost/uncertain commit cannot be reported as a usable GFS credential.
 */
export async function signCurrentExternalGfsUserToken(
  authentication: AuthenticatedExternalSession | undefined,
  input: ExternalGfsUserTokenInput
): Promise<{ token: string; expiresInSeconds: number } | null> {
  if (!authentication) return null
  const context = authentication.authorityContext
  const tokenClaims = authentication.tokenClaims
  const hasLegacySubject = 'userId' in tokenClaims
  const tokenSubject = hasLegacySubject ? tokenClaims.userId : tokenClaims.sub
  const expiresAt = authentication.tokenClaims.exp
  if (
    context.contract !== authentication.contract ||
    (authentication.contract === 'v1') !== hasLegacySubject ||
    context.userId !== input.subject ||
    tokenSubject !== context.userId ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 1
  ) {
    return null
  }

  try {
    return await withTransaction(
      async transaction => {
        const current = await validateExternalSessionAuthorityContext(context, {
          db: transaction,
        })
        if (current.status !== 'valid' || current.identity.userId !== context.userId) return null

        const result = await transaction.query(
          `SELECT lifecycle_state, lifecycle_version, clock_timestamp() AS db_now
             FROM users
            WHERE id = $1`,
          [context.userId]
        )
        const row = result.rows[0] as
          | {
              lifecycle_state?: unknown
              lifecycle_version?: unknown
              db_now?: Date | string
            }
          | undefined
        const generation = Number(row?.lifecycle_version)
        const dbNow = row?.db_now instanceof Date ? row.db_now : new Date(String(row?.db_now ?? ''))
        if (
          row?.lifecycle_state !== 'active' ||
          !Number.isSafeInteger(generation) ||
          generation < 1 ||
          !Number.isFinite(dbNow.getTime()) ||
          expiresAt * 1000 <= dbNow.getTime()
        ) {
          return null
        }

        return signGfsToken({
          subject: input.subject,
          drive: input.drive,
          scopes: input.scopes,
          ...(input.pathBindings === undefined ? {} : { pathBindings: input.pathBindings }),
          ...(input.actionAuthority === undefined
            ? {}
            : { actionAuthority: input.actionAuthority }),
          authGeneration: generation,
          principalType: 'user',
        })
      },
      undefined,
      { onDatabaseFailure: externalSessionDatabaseFailure }
    )
  } catch (error) {
    if (isExternalSessionBackendUnavailableError(error)) {
      throw new ExternalGfsAuthorityError(503, 'gfs_authority_unavailable', { cause: error })
    }
    throw error
  }
}

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
