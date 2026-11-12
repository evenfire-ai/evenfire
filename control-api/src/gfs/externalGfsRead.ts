import { GFS_READ_SCOPE, signGfsToken } from '../auth/gfsToken.js'
import { config } from '../config.js'
import {
  type AuthenticatedExternalSession,
  type ExternalGfsAuthority,
  signCurrentExternalGfsUserToken,
} from './externalAuthority.js'

/**
 * Mint the `gfs.read` token one external caller uses against gfsc for `drive`.
 *
 * A linked operator signs locally as `control-admin` with the brokered
 * authority gfsc requires to decide by the operator's grants. A user-session
 * signs through `signCurrentExternalGfsUserToken`, which revalidates the
 * session against the database and takes the generation from the row.
 *
 * Resolves `null` when the session is no longer current (the caller answers
 * 401) and rejects with `ExternalGfsAuthorityError(503)` when the session
 * database cannot answer. No abort signal: the user-session read holds a pooled
 * connection for one unlocked statement and must be allowed to return it.
 */
export async function mintExternalGfsReadToken(
  authentication: AuthenticatedExternalSession | undefined,
  authority: ExternalGfsAuthority,
  drive: string
): Promise<{ token: string; expiresInSeconds: number } | null> {
  if (authority.kind === 'linked-admin') {
    return signGfsToken({
      subject: authority.tokenSubject,
      drive,
      scopes: [GFS_READ_SCOPE],
      ...(authority.authGeneration === undefined
        ? {}
        : { authGeneration: authority.authGeneration }),
      principalType: 'control-admin',
      brokeredAuthority: {
        desktopUserId: authority.desktopUserId,
        controlAdminId: authority.controlAdminId,
        authoritySource: authority.authoritySource,
        linkLineageId: authority.linkLineageId,
        linkGeneration: authority.linkGeneration,
        desktopUserGeneration: authority.desktopUserGeneration,
      },
    })
  }
  return signCurrentExternalGfsUserToken(authentication, {
    subject: authority.tokenSubject,
    drive,
    scopes: [GFS_READ_SCOPE],
  })
}

/**
 * Outcome of reading one resource's metadata from gfsc. `responded` is false
 * when no HTTP response arrived (network failure, abort or timeout), so a
 * caller measuring gfsc throughput can count only real answers.
 *
 * `kind` is gfsc's raw view kind ('file' | 'directory'); normalizing it is the
 * caller's job so there is a single place that maps gfsc's vocabulary.
 */
export type GfscReadResult =
  | { status: '2xx'; kind: string | null; principalDenied: false; responded: true }
  | { status: 401 | 404 | 410; principalDenied: false; responded: true }
  | { status: 403; principalDenied: boolean; responded: true }
  | { status: 'transient'; httpStatus?: number; principalDenied: false; responded: boolean }

export const GFSC_READ_TRANSIENT_NO_RESPONSE: GfscReadResult = Object.freeze({
  status: 'transient',
  principalDenied: false,
  responded: false,
})

function transientResponse(httpStatus: number): GfscReadResult {
  return { status: 'transient', httpStatus, principalDenied: false, responded: true }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function envelopeErrorReason(body: unknown): unknown {
  const error = (body as { error?: { reason?: unknown } } | null | undefined)?.error
  return typeof error === 'object' && error !== null ? error.reason : undefined
}

/**
 * Stat one resource on gfsc (`GET /v1/resources/:rid`) with an already minted
 * token. Total: it never rejects. 409, 429, 5xx, an unparseable 2xx body,
 * network failures, aborts and the deadline are all `transient`; 401 stays
 * separate because it means the token was refused, not the user.
 *
 * `signal` cancels the read; `timeoutMs` bounds headers and body together.
 */
export async function readGfsc(
  resourceId: string,
  token: string,
  requestId: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<GfscReadResult> {
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const target = `${config.gfscBaseUrl.replace(/\/+$/, '')}/v1/resources/${encodeURIComponent(resourceId)}`
    let response: Response
    try {
      response = await fetch(target, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'x-request-id': requestId },
        signal: deadline,
      })
    } catch {
      return GFSC_READ_TRANSIENT_NO_RESPONSE
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      return transientResponse(response.status)
    }
    const status = response.status
    if (status >= 200 && status < 300) {
      const data = (parseJson(text) as { ok?: unknown; data?: { kind?: unknown } } | undefined)
        ?.data
      if (typeof data !== 'object' || data === null) return transientResponse(status)
      return {
        status: '2xx',
        kind: typeof data.kind === 'string' ? data.kind : null,
        principalDenied: false,
        responded: true,
      }
    }
    if (status === 403) {
      return {
        status: 403,
        principalDenied: envelopeErrorReason(parseJson(text)) === 'principal_denied',
        responded: true,
      }
    }
    if (status === 401 || status === 404 || status === 410) {
      return { status, principalDenied: false, responded: true }
    }
    return transientResponse(status)
  } catch {
    return GFSC_READ_TRANSIENT_NO_RESPONSE
  }
}
