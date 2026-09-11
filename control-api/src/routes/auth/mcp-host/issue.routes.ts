import { RequestHandler, Router } from 'express'
import { config } from '../../../config.js'
import { requireInternalControlJwt } from '../../../middleware/internalControlJwt.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import {
  ALL_MCP_HOST_CONTROL_SCOPES,
  type McpHostControlScope,
  issueMcpHostAccessJwt,
  issueMcpHostControlJwt,
  issueMcpHostRefreshJwt,
} from '../../../utils/auth/mcpHostJwtToken.js'

const MCP_HOST_CONTROL_SCOPE_SET = new Set<string>(ALL_MCP_HOST_CONTROL_SCOPES)

function expectedNamespacesForProvisioner(iss: string): string[] {
  if (iss === 'hcc') return [config.hostsNamespace]
  if (iss === 'wrc') return [config.sandboxNamespace]
  return []
}

function shouldIncludeMcpHostControlToken(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === 'object' &&
    'includeMcpHostControlToken' in body &&
    (body as { includeMcpHostControlToken?: unknown }).includeMcpHostControlToken === true
  )
}

function resolveWorkflowControlScopes(
  body: unknown
): { scopes: McpHostControlScope[] } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'workflow_control_scopes_required' }
  const raw = (body as { workflowControlScopes?: unknown }).workflowControlScopes
  if (!Array.isArray(raw)) return { error: 'workflow_control_scopes_required' }

  const scopes: McpHostControlScope[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'invalid_workflow_control_scopes' }
    const scope = entry.trim()
    if (!MCP_HOST_CONTROL_SCOPE_SET.has(scope) || seen.has(scope)) {
      return { error: 'invalid_workflow_control_scopes' }
    }
    seen.add(scope)
    scopes.push(scope as McpHostControlScope)
  }
  return { scopes }
}

/** RFC1123 label — same shape Kubernetes enforces for resource names. */
const HOST_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/**
 * For HCC issuance, the body must carry the actual Host CRD name so the
 * minted JWT's hostRefs[0] identifies the bearer pod (not the sentinel
 * recipe pair). Returns the validated host name or an error code.
 */
function resolveHostName(body: unknown): { hostName: string } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'host_required' }
  const raw = (body as { host?: unknown }).host
  if (typeof raw !== 'string') return { error: 'host_required' }
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'host_required' }
  if (trimmed !== raw || trimmed.length > 63 || !HOST_NAME_RE.test(trimmed)) {
    return { error: 'invalid_host_name' }
  }
  return { hostName: trimmed }
}

function resolveHostUid(body: unknown): { hostUid: string } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'host_uid_required' }
  const raw = (body as { hostUid?: unknown }).hostUid
  if (typeof raw !== 'string') return { error: 'host_uid_required' }
  const trimmed = raw.trim()
  if (!trimmed || trimmed !== raw || trimmed.length > 128 || /[^A-Za-z0-9._:-]/.test(trimmed)) {
    return { error: 'invalid_host_uid' }
  }
  return { hostUid: trimmed }
}

function resolveIssueTarget(req: {
  params: { namespace?: string; name?: string; recipe?: string }
}): { namespace: string; name: string } | { error: string } {
  const namespace = String(req.params.namespace ?? '').trim()
  const name = String(req.params.name ?? req.params.recipe ?? '').trim()
  if (!namespace || !name) {
    return { error: 'recipeNamespace and recipeName are required' }
  }
  return { namespace, name }
}

export function createAuthMcpHostIssueRoutes(): Router {
  const router = Router()

  function issueCanonicalTokens(): RequestHandler {
    return (req, res, next) => {
      void (async () => {
        try {
          const provisioner = req.internalControl!
          const expectedNamespaces = expectedNamespacesForProvisioner(provisioner.iss)
          if (expectedNamespaces.length === 0) {
            return res.status(403).json({ error: 'invalid_provisioner_for_route' })
          }

          const target = resolveIssueTarget(req)
          if ('error' in target) {
            return res.status(400).json({ error: target.error })
          }

          const recipeNamespace = target.namespace
          const recipeName = target.name

          if (!shouldIncludeMcpHostControlToken(req.body)) {
            return res.status(400).json({ error: 'includeMcpHostControlToken must be true' })
          }
          const controlScopes = resolveWorkflowControlScopes(req.body)
          if ('error' in controlScopes) {
            return res.status(400).json({ error: controlScopes.error })
          }

          if (!expectedNamespaces.includes(recipeNamespace)) {
            return res.status(403).json({ error: 'provisioner_namespace_mismatch' })
          }

          if (!config.allowedIssuanceNamespaces.includes(recipeNamespace.toLowerCase())) {
            return res.status(400).json({ error: 'invalid_issuance_namespace' })
          }

          if (provisioner.iss === 'hcc' && recipeName !== 'standalone') {
            return res.status(403).json({ error: 'provisioner_target_mismatch' })
          }

          // 1st-party (hcc): hostRefs[0] is the actual Host CRD name so per-event
          // identity binding can verify the bearer pod is acting on its own behalf.
          // 3rd-party (wrc): hostRefs[0] keeps the recipe-binding shape — recipe
          // pods don't run on a single named host. Authorization for recipe tokens
          // uses recipeNamespace/recipeName instead.
          let hostRefs: string[]
          let hccCredential: { hostUid: string } | undefined
          if (provisioner.iss === 'hcc') {
            const hostResolved = resolveHostName(req.body)
            if ('error' in hostResolved) {
              return res.status(400).json({ error: hostResolved.error })
            }
            const uidResolved = resolveHostUid(req.body)
            if ('error' in uidResolved) {
              return res.status(400).json({ error: uidResolved.error })
            }
            hostRefs = [hostResolved.hostName]
            hccCredential = { hostUid: uidResolved.hostUid }
          } else {
            hostRefs = [`${recipeNamespace}/${recipeName}`]
          }

          const access = issueMcpHostAccessJwt(recipeNamespace, recipeName, hostRefs, {
            workflowControlScopes: controlScopes.scopes,
            hccCredential,
          })
          const refresh = issueMcpHostRefreshJwt(recipeNamespace, recipeName, hostRefs, {
            workflowControlScopes: controlScopes.scopes,
            hccCredential,
          })
          const control = issueMcpHostControlJwt(recipeNamespace, recipeName, hostRefs, {
            scopes: controlScopes.scopes,
          })
          req.log?.info(
            {
              event: 'mcp_host_credentials_issued',
              provisioner: provisioner.iss,
              accessTtlSec: access.expiresInSeconds,
              controlTtlSec: control.expiresInSeconds,
              workflowControlScopeCount: controlScopes.scopes.length,
              hccQualified: hccCredential !== undefined,
            },
            'mcpHost credentials issued'
          )

          return res.status(200).json({
            mcpHostAccessToken: access.token,
            mcpHostRefreshToken: refresh.token,
            mcpHostControlToken: control.token,
            expiresInSeconds: {
              access: access.expiresInSeconds,
              refresh: refresh.expiresInSeconds,
              control: control.expiresInSeconds,
            },
            hostRefs,
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  }

  router.post(
    '/auth/mcp-host/:namespace/:name/tokens',
    mcpHostHttpMetrics('workflows_auth_issue'),
    requireInternalControlJwt,
    issueCanonicalTokens()
  )

  return router
}
