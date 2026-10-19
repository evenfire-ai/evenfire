import type { NextFunction, Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { type ProfileLinkContextV1, normalizeProfileUiBaseUrl } from '@clerum/desktop-app-links'
import { config } from '../config'
import type { RuntimeCallerContext, RuntimeCallerKind } from './types'

const EDGE_CALLER_HEADER = 'x-clerum-edge-caller'
const EDGE_HOST_REF_HEADER = 'x-clerum-edge-host-ref'
const EDGE_USER_ID_HEADER = 'x-clerum-edge-user-id'
const EDGE_TEAM_ID_HEADER = 'x-clerum-edge-team-id'
const EDGE_REQUEST_ID_HEADER = 'x-clerum-edge-request-id'
const EDGE_CHANNEL_TYPE_HEADER = 'x-clerum-edge-channel-type'
const EDGE_CHANNEL_ID_HEADER = 'x-clerum-edge-channel-id'
const EDGE_SENDER_HEADER = 'x-clerum-edge-sender'
const EDGE_PROFILE_LINK_CONTEXT_HEADER = 'x-clerum-edge-profile-link-context'
const WORKFLOW_RUNTIME_ALIAS_REF_RE = /^([^/]+)\/~([0-9a-f]{16})$/

function firstHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function cleanHeader(req: Request, name: string): string | undefined {
  const value = firstHeaderValue(req, name)?.trim()
  return value ? value : undefined
}

function profileLinkContextForCaller(
  req: Request,
  caller: RuntimeCallerContext
): ProfileLinkContextV1 | undefined {
  const userId = caller.userId
  const hostRef = caller.hostRef
  if (!userId || !hostRef) return undefined

  const encoded = cleanHeader(req, EDGE_PROFILE_LINK_CONTEXT_HEADER)
  if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined
  }

  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return undefined
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const profileUiBaseUrl =
      typeof parsed.profileUiBaseUrl === 'string'
        ? normalizeProfileUiBaseUrl(parsed.profileUiBaseUrl)
        : null
    if (
      parsed.version !== 1 ||
      parsed.userId !== userId ||
      parsed.teamId !== (caller.teamId ?? null) ||
      parsed.hostRef !== hostRef ||
      !profileUiBaseUrl ||
      parsed.profileUiBaseUrl !== profileUiBaseUrl
    ) {
      return undefined
    }
    return {
      version: 1,
      userId,
      teamId: caller.teamId ?? null,
      hostRef,
      profileUiBaseUrl,
    }
  } catch {
    return undefined
  }
}

function readRuntimeCaller(req: Request): RuntimeCallerContext | null {
  const caller = cleanHeader(req, EDGE_CALLER_HEADER)
  if (
    caller !== 'rpc-proxy' &&
    caller !== 'channel-reader' &&
    caller !== 'workflow-approval-request-reader'
  ) {
    return null
  }

  const context: RuntimeCallerContext = {
    caller,
    hostRef: cleanHeader(req, EDGE_HOST_REF_HEADER),
    requestId: cleanHeader(req, EDGE_REQUEST_ID_HEADER),
  }

  if (caller === 'rpc-proxy') {
    context.userId = cleanHeader(req, EDGE_USER_ID_HEADER)
    context.teamId = cleanHeader(req, EDGE_TEAM_ID_HEADER)
    context.profileLinkContext = profileLinkContextForCaller(req, context)
  } else {
    context.channelType = cleanHeader(req, EDGE_CHANNEL_TYPE_HEADER)
    context.channelId = cleanHeader(req, EDGE_CHANNEL_ID_HEADER)
    context.sender = cleanHeader(req, EDGE_SENDER_HEADER)
  }

  return context
}

function routeAliasForHostRef(hostRef: string): string | null {
  const [namespace, name, ...rest] = hostRef.split('/')
  if (!namespace || !name || rest.length > 0) return null
  const hash = createHash('sha256').update(hostRef).digest('hex').slice(0, 16)
  return `${namespace}/~${hash}`
}

function hostRefMatchesRuntimeHost(hostRef: string, runtimeHost: string): boolean {
  if (hostRef === runtimeHost) return true
  const alias = hostRef.match(WORKFLOW_RUNTIME_ALIAS_REF_RE)
  if (!alias) return false
  const runtimeAlias = routeAliasForHostRef(runtimeHost)
  return runtimeAlias === hostRef
}

export function getRuntimeCallerContext(req: Request): RuntimeCallerContext | undefined {
  return (req as Request & { runtimeCaller?: RuntimeCallerContext }).runtimeCaller
}

export function runtimeEdgeGuard(allowedCallers: RuntimeCallerKind[]) {
  const allowed = new Set<RuntimeCallerKind>(allowedCallers)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.authorization) {
      res
        .status(401)
        .json({ error: 'Authorization is not accepted on this direct mcp-host runtime route' })
      return
    }

    const context = readRuntimeCaller(req)
    if (!context || !allowed.has(context.caller)) {
      res.status(401).json({ error: 'Missing runtime edge caller context' })
      return
    }

    if (!context.hostRef) {
      res.status(401).json({ error: 'Missing runtime edge host context' })
      return
    }
    if (context.caller === 'rpc-proxy' && !context.userId) {
      res.status(401).json({ error: 'Missing rpc edge caller context' })
      return
    }
    if (context.hostRef && !hostRefMatchesRuntimeHost(context.hostRef, config.hostName)) {
      res.status(403).json({ error: 'Runtime edge host mismatch' })
      return
    }

    ;(req as Request & { runtimeCaller?: RuntimeCallerContext }).runtimeCaller = context
    next()
  }
}
