/**
 * Host identity for HCC MCP discovery/auth routes.
 *
 * Caller-supplied Context, Host name, or unsigned headers are not authority.
 * Production maps a Kubernetes TokenReview of the per-Host ServiceAccount
 * onto Host.spec.contextRef from HCC's own cache.
 */
import * as k8s from '@kubernetes/client-node'
import type * as http from 'http'
import { hostServiceAccountName } from './hostServiceAccount'
import { getKubeConfig } from './k8sClient'
import type { HostCRD } from './types'

export type McpCaller = {
  hostRef: string
  contextRef: string
}

export type McpCallerResolver = (req: http.IncomingMessage) => Promise<McpCaller | null>

export type TokenReviewResult = {
  authenticated: boolean
  username?: string
}

export function parseBearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== 'string') return null
  const match = /^(?:Bearer)\s+(\S+)$/i.exec(authorization.trim())
  return match?.[1] ?? null
}

export function hostRefFromServiceAccountUser(
  username: string,
  hostNamespace: string
): string | null {
  const prefix = `system:serviceaccount:${hostNamespace}:`
  if (!username.startsWith(prefix)) return null
  const saName = username.slice(prefix.length)
  const expectedPrefix = 'host-'
  const expectedSuffix = '-sa'
  if (!saName.startsWith(expectedPrefix) || !saName.endsWith(expectedSuffix)) return null
  const hostRef = saName.slice(expectedPrefix.length, saName.length - expectedSuffix.length)
  if (!hostRef || hostServiceAccountName(hostRef) !== saName) return null
  return hostRef
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Normalize TokenReview API shapes to an authentication result.
 * client-node `createTokenReview` returns the V1TokenReview body (`apiResponse.data`).
 */
export function tokenReviewResultFromResponse(review: unknown): TokenReviewResult {
  const obj = asRecord(review)
  if (!obj) return { authenticated: false }
  const status = asRecord(obj.status) ?? asRecord(asRecord(obj.data)?.status)
  if (!status?.authenticated) return { authenticated: false }
  const user = asRecord(status.user)
  const username = typeof user?.username === 'string' ? user.username : undefined
  if (!username) return { authenticated: false }
  return { authenticated: true, username }
}

export function createTokenReviewMcpCallerResolver(options: {
  hostNamespace: string
  getHost: (name: string) => HostCRD | undefined
  reviewToken: (token: string) => Promise<TokenReviewResult>
}): McpCallerResolver {
  return async req => {
    try {
      const token = parseBearerToken(req.headers.authorization)
      if (!token) return null
      const review = await options.reviewToken(token)
      if (!review.authenticated || !review.username) return null
      const hostRef = hostRefFromServiceAccountUser(review.username, options.hostNamespace)
      if (!hostRef) return null
      const host = options.getHost(hostRef)
      const contextRef = host?.spec.contextRef?.trim()
      if (!host || !contextRef) return null
      return { hostRef, contextRef }
    } catch (err) {
      console.error('[Server] MCP caller resolution failed:', err)
      return null
    }
  }
}

export function buildMcpCallerResolver(options: {
  devMode: boolean
  hostNamespace: string
  getHost: (name: string) => HostCRD | undefined
  reviewToken: (token: string) => Promise<TokenReviewResult>
  devContextRef: string
}): McpCallerResolver {
  if (options.devMode) {
    return async () => ({
      hostRef: 'dev',
      contextRef: options.devContextRef,
    })
  }
  return createTokenReviewMcpCallerResolver({
    hostNamespace: options.hostNamespace,
    getHost: options.getHost,
    reviewToken: options.reviewToken,
  })
}

/**
 * TokenReview of a presented bearer. Fail-closed on missing kube config or API errors.
 */
export async function reviewKubernetesToken(token: string): Promise<TokenReviewResult> {
  const kubeConfig = getKubeConfig()
  if (!kubeConfig) return { authenticated: false }
  try {
    const api = kubeConfig.makeApiClient(k8s.AuthenticationV1Api)
    const review = await api.createTokenReview({
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token },
      },
    })
    return tokenReviewResultFromResponse(review)
  } catch (err) {
    console.error('[Server] TokenReview failed:', err)
    return { authenticated: false }
  }
}
