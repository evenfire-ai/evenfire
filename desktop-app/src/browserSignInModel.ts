/**
 * The browser sign-in rules that Desktop's main process and its renderer share. Nothing here
 * imports Electron or Node, so renderer tests can import this module, as `App.tsx` imports
 * `desktopCommands`.
 *
 * It is the only Desktop module that imports PR 2's Desktop-login names from
 * `@clerum/desktop-app-links`. Every other Desktop file, and every test, takes them from here.
 */
import {
  DESKTOP_LOGIN_DEEP_LINK_HOST,
  DESKTOP_LOGIN_PATH,
  DESKTOP_LOGIN_REFUSAL_REASONS,
  buildDesktopLoginCodeLink,
  buildDesktopLoginErrorLink,
  buildDesktopLoginPageUrl,
  parseDesktopLoginLink,
  parseDesktopLoginPageUrl,
  parseDesktopLoginSignInUrl,
} from '@clerum/desktop-app-links'
import type { BrowserSignInSnapshot, LoginMethodsModel } from './types.js'

export {
  DESKTOP_LOGIN_DEEP_LINK_HOST,
  DESKTOP_LOGIN_PATH,
  DESKTOP_LOGIN_REFUSAL_REASONS,
  buildDesktopLoginPageUrl,
  parseDesktopLoginLink,
  parseDesktopLoginPageUrl,
  parseDesktopLoginSignInUrl,
}
/** Test-only: they write the links the Profile UI sends. */
export { buildDesktopLoginCodeLink, buildDesktopLoginErrorLink }
export type {
  DesktopLoginLink,
  DesktopLoginPageValues,
  DesktopLoginRefusalReason,
} from '@clerum/desktop-app-links'

/**
 * `GET /api/v1/auth/methods` as main read it. A 503, another 5xx or a network failure is
 * `unreachable` (design §10.1).
 */
export type LoginMethodsHttpAnswer =
  | { status: 200; body: unknown }
  | { status: 404 }
  | { status: 'unreachable' }

/** `POST /api/v1/oidc/desktop-sign-in/redeem` as main read it. */
export type RedeemHttpAnswer =
  | { status: 200; body: unknown }
  | { status: number; bodyText: string }
  | { status: 'unreachable' }

/** The edge's own bound on the provider label (`external-rest-api/src/routes/authMethods.ts`). */
const OIDC_LABEL_MAX_LENGTH = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listsMethod(body: unknown, method: string): boolean {
  return isRecord(body) && Array.isArray(body.methods) && body.methods.includes(method)
}

/**
 * The `oidc` method when Desktop can offer it, with `signInUrl` as PR 2's parser normalized it;
 * otherwise null. Desktop never re-implements the `signInUrl` shape rule: the parser is the rule.
 */
export function readUsableOidc(
  answer: LoginMethodsHttpAnswer,
  options: { linksAvailable: boolean }
): { label: string; signInUrl: string } | null {
  // An instance that cannot receive the `desktop-login` link would wait out the deadline (D16).
  if (!options.linksAvailable || answer.status !== 200) return null
  if (!listsMethod(answer.body, 'oidc')) return null
  const oidc = isRecord(answer.body) ? answer.body.oidc : undefined
  if (!isRecord(oidc)) return null
  const { label, signInUrl } = oidc
  if (typeof label !== 'string' || label.length < 1 || label.length > OIDC_LABEL_MAX_LENGTH) {
    return null
  }
  // The parser is typed for a string; a body is not.
  if (typeof signInUrl !== 'string') return null
  const normalized = parseDesktopLoginSignInUrl(signInUrl)
  return normalized === null ? null : { label, signInUrl: normalized }
}

/** The login screen for one methods answer (design §10.1). Unknown method names are ignored. */
export function buildLoginMethodsModel(
  answer: LoginMethodsHttpAnswer,
  options: { linksAvailable: boolean }
): LoginMethodsModel {
  if (answer.status === 'unreachable') return { kind: 'unreachable' }
  // A server older than the endpoint still accepts passwords (Decision 7).
  if (answer.status === 404) return { kind: 'methods', provider: null, password: true }
  const oidc = readUsableOidc(answer, options)
  const password = listsMethod(answer.body, 'password')
  if (!oidc && !password) return { kind: 'misconfigured' }
  return { kind: 'methods', provider: oidc ? { label: oidc.label } : null, password }
}

/** Within one attempt: waiting, then redeeming, then ended, then idle once acknowledged. */
export const BROWSER_SIGN_IN_PHASE_RANK: Readonly<Record<BrowserSignInSnapshot['phase'], number>> =
  Object.freeze({ waiting: 1, redeeming: 2, ended: 3, idle: 4 })

/** Orders by attempt id, a `null` id lowest, then by phase rank. Returns -1, 0 or 1. */
export function compareBrowserSignInSnapshots(
  a: BrowserSignInSnapshot,
  b: BrowserSignInSnapshot
): number {
  if (a.attemptId !== b.attemptId) {
    if (a.attemptId === null) return -1
    if (b.attemptId === null) return 1
    return a.attemptId < b.attemptId ? -1 : 1
  }
  return Math.sign(BROWSER_SIGN_IN_PHASE_RANK[a.phase] - BROWSER_SIGN_IN_PHASE_RANK[b.phase])
}

/** The candidate only when it is strictly newer; otherwise the current snapshot. */
export function newerBrowserSignInSnapshot(
  current: BrowserSignInSnapshot,
  candidate: BrowserSignInSnapshot
): BrowserSignInSnapshot {
  return compareBrowserSignInSnapshots(candidate, current) > 0 ? candidate : current
}
