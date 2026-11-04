import { type Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { CONTENT_TYPES } from '../../http/contentTypes.js'
import { statusMessageOf } from '../../http/k8sError.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { K8sGateway } from '../../k8s.js'
import { rootLogger } from '../../observability/logger.js'
import { loadHostSecretEntries, redactArtifactBuffer } from '../../services/artifactRedactor.js'
import { ResourceReadError, SecretReadError } from '../../services/secretRead.js'

const BASE = '/admin/hosts'
const BINARY_ARTIFACT_FORMATS = new Set(['doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx', 'zip'])

class HostPodNotFoundError extends Error {
  constructor(
    readonly hostRef: string,
    readonly podName: string
  ) {
    super(`pod not found for host ${hostRef}`)
    this.name = 'HostPodNotFoundError'
  }
}

const logger = rootLogger
const MODULE = 'admin-host-artifacts'

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    try {
      const safeFields = ['code', 'reason', 'statusCode', 'message']
      const details = Object.fromEntries(
        safeFields
          .filter(key => Object.prototype.hasOwnProperty.call(err, key))
          .map(key => [key, (err as Record<string, unknown>)[key]])
      )
      const serialized = JSON.stringify(details)
      return serialized === '{}' ? 'non-error object thrown' : serialized
    } catch {
      return 'unknown non-error object thrown'
    }
  }
  return String(err)
}

function isPodNotFoundError(err: unknown): boolean {
  if (err instanceof HostPodNotFoundError) return true
  const msg = errorMessage(err)
  return /\bpods?\b[^.]*\bnot found\b/i.test(msg) || /\bpod not found\b/i.test(msg)
}

function isArtifactNotFoundError(err: unknown): boolean {
  return (
    !isPodNotFoundError(err) && /not found|no such file|no such directory/i.test(errorMessage(err))
  )
}

function isExecPolicyError(err: unknown): boolean {
  return /exec rejected|symlink artifacts are not allowed|path traversal|not a regular file/i.test(
    errorMessage(err)
  )
}

function isArtifactTooLargeError(err: unknown): boolean {
  return /artifact too large/i.test(errorMessage(err))
}

function isArtifactListingTooLargeError(err: unknown): boolean {
  return /artifact listing too large/i.test(errorMessage(err))
}

function podNameFromError(err: unknown, fallback: string): string {
  return err instanceof HostPodNotFoundError ? err.podName : fallback
}

function podNameFromHostArtifactError(err: unknown, fallback: string): string {
  const podName = (err as { hostArtifactPodName?: unknown })?.hostArtifactPodName
  return typeof podName === 'string' && podName ? podName : podNameFromError(err, fallback)
}

function sendPodNotFound(res: Response, hostRef: string, podName: string): void {
  res.status(404).json({
    error: 'Host pod not found',
    error_code: 'pod_not_found',
    hostRef,
    podName,
  })
}

function redactionHeaderValue(
  ext: string,
  redactedCount: number
): 'applied' | 'scanned' | 'skipped:binary' {
  if (redactedCount > 0) return 'applied'
  return isBinaryArtifactFormat(ext) ? 'skipped:binary' : 'scanned'
}

function isBinaryArtifactFormat(ext: string): boolean {
  return BINARY_ARTIFACT_FORMATS.has(ext.replace(/^\./, '').toLowerCase())
}

async function resolveHostPod(
  gateway: K8sGateway,
  hostRef: string
): Promise<{ podName: string; namespace: string }> {
  const ns = config.hostsNamespace
  const podName = await gateway.findPodByLabel(ns, `clerum.io/host=${hostRef}`)
  if (!podName) {
    throw new HostPodNotFoundError(hostRef, hostRef)
  }
  return { podName, namespace: ns }
}

export async function listHostArtifactsForHost(
  gateway: K8sGateway,
  hostRef: string
): Promise<{
  artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
  hostRef: string
  podName: string
}> {
  const { podName, namespace } = await resolveHostPod(gateway, hostRef)
  const outputDir = '/tmp/clerum-output/'

  let output: string
  try {
    output = await gateway.listFilesInDirectory(podName, namespace, undefined, outputDir)
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(errorMessage(err)), {
      hostArtifactPodName: podName,
    })
  }

  const lines = output.trim().split('\n').filter(Boolean)
  const artifacts = lines
    .map(line => {
      const parts = line.split('\t')
      if (parts.length >= 3) {
        // find -printf output: name\tsize\tepoch
        const name = parts[0]
        const sizeBytes = parseInt(parts[1], 10) || 0
        const epoch = parseFloat(parts[2]) || 0
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        return {
          name,
          format: ext,
          sizeBytes,
          createdAt: epoch ? new Date(epoch * 1000).toISOString() : '',
        }
      }
      // Fallback: just filename from ls
      const name = parts[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      return { name, format: ext, sizeBytes: 0, createdAt: '' }
    })
    .filter(a => a.name && !a.name.startsWith('.'))

  return { artifacts, hostRef, podName }
}

/**
 * Admin chat-mode artifact endpoints.
 *
 * These endpoints list and download artifacts generated by mcp-host pods
 * running in chat mode (non-workflow). The files live at /tmp/clerum-output
 * inside the host pod. WorkflowRecipe artifact downloads use the delegated
 * mcp-host path instead; this route stays scoped to admin host-pod artifacts.
 */
export function createAdminHostArtifactsRouter(gateway: K8sGateway): Router {
  const router = Router()

  // ── List artifacts from a host pod ──────────────────────────────────────
  router.get(
    `${BASE}/:hostRef/artifacts`,
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const hostRef = req.params.hostRef
      if (!hostRef || !RFC1123_RE.test(hostRef)) {
        res.status(400).json({ error: 'Invalid host reference' })
        return
      }

      try {
        const result = await listHostArtifactsForHost(gateway, hostRef)
        res.status(200).json(result)
      } catch (err) {
        const podName = podNameFromHostArtifactError(err, hostRef)
        if (isArtifactListingTooLargeError(err)) {
          res.status(413).json({ error: 'Artifact listing too large to return' })
          return
        }
        if (isPodNotFoundError(err)) {
          logger.warn(
            { module: MODULE, hostRef, podName, err: errorMessage(err) },
            'Host pod not found while listing artifacts'
          )
          sendPodNotFound(res, hostRef, podName)
          return
        }
        if (isArtifactNotFoundError(err)) {
          res.status(200).json({ artifacts: [], hostRef, podName })
          return
        }
        if (isExecPolicyError(err)) {
          res.status(403).json({ error: 'Artifact listing rejected by exec policy' })
          return
        }
        logger.warn(
          { module: MODULE, hostRef, podName, err: errorMessage(err) },
          'Failed to list artifacts'
        )
        res.status(502).json({ error: 'Failed to list artifacts from host pod' })
      }
    })
  )

  // ── Download a specific artifact from a host pod ────────────────────────
  router.get(
    `${BASE}/:hostRef/artifacts/:artifactName/download`,
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const hostRef = req.params.hostRef
      if (!hostRef || !RFC1123_RE.test(hostRef)) {
        res.status(400).json({ error: 'Invalid host reference' })
        return
      }

      const artifactName = req.params.artifactName
      // Security: block slashes, null bytes, and path traversal
      if (!artifactName || /[/\\\x00]/.test(artifactName) || artifactName.includes('..')) {
        res.status(400).json({ error: 'Invalid artifact name' })
        return
      }

      try {
        const { podName, namespace } = await resolveHostPod(gateway, hostRef)
        const filePath = `/tmp/clerum-output/${artifactName}`

        let fileBuffer: Buffer
        try {
          fileBuffer = await gateway.readFileFromPod(podName, namespace, undefined, filePath)
        } catch (err) {
          if (isArtifactTooLargeError(err)) {
            res.status(413).json({ error: 'Artifact too large to download' })
            return
          }
          if (isPodNotFoundError(err)) {
            logger.warn(
              { module: MODULE, hostRef, podName, err: errorMessage(err) },
              'Host pod not found while reading an artifact'
            )
            sendPodNotFound(res, hostRef, podNameFromError(err, podName))
            return
          }
          if (isArtifactNotFoundError(err)) {
            res
              .status(404)
              .json({ error: `Artifact "${artifactName}" not found in host pod "${podName}"` })
            return
          }
          if (isExecPolicyError(err)) {
            res.status(403).json({ error: 'Artifact read rejected by exec policy' })
            return
          }
          logger.warn(
            { module: MODULE, hostRef, podName, artifactName, err: errorMessage(err) },
            'Failed to read artifact'
          )
          res.status(502).json({ error: 'Failed to read artifact from host pod' })
          return
        }

        const ext = artifactName.split('.').pop()?.toLowerCase() ?? ''
        const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'

        // Redact ConfigStore-managed secret values before streaming text artifacts.
        // Binary office/PDF/ZIP formats must remain byte-exact: replacing a raw
        // secret byte sequence with a textual marker can corrupt the container.
        const secretEntries = isBinaryArtifactFormat(ext)
          ? []
          : await loadHostSecretEntries(gateway, hostRef, namespace)
        const { buffer: redactedBuffer, redactedCount } = isBinaryArtifactFormat(ext)
          ? { buffer: fileBuffer, redactedCount: 0 }
          : redactArtifactBuffer(fileBuffer, secretEntries)
        if (redactedCount > 0) {
          logger.warn(
            { module: MODULE, hostRef, artifactName, redactedCount },
            'Redacted secret values from an artifact'
          )
        }

        res.setHeader('Content-Type', contentType)
        const safeFilename = artifactName.replace(/[^a-zA-Z0-9_.\-]/g, '_')
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
        // Signal to the desktop that the file went through redaction. Binary
        // formats may still contain compressed/encoded copies of secrets we
        // couldn't substring-match — the header lets the UI surface that
        // caveat next to the Download button if it wants to.
        res.setHeader('X-Clerum-Redaction', redactionHeaderValue(ext, redactedCount))
        res.setHeader('Content-Length', String(redactedBuffer.length))
        res.send(redactedBuffer)
      } catch (err) {
        // The redaction source could not be read: the global handler answers
        // 502/503 with a fixed message, and the artifact is never sent.
        if (err instanceof SecretReadError || err instanceof ResourceReadError) throw err
        if (isPodNotFoundError(err)) {
          sendPodNotFound(res, hostRef, podNameFromError(err, hostRef))
          return
        }
        // Never echo the error text: a K8s ApiException message (e.g. from the
        // pod lookup) embeds the apiserver's Status body and response headers.
        const msg = err instanceof Error ? err.message : ''
        logger.warn(
          {
            module: MODULE,
            hostRef,
            artifactName,
            err: statusMessageOf(err) ?? (err instanceof Error ? err.name : typeof err),
          },
          'Artifact download failed'
        )
        if (msg.includes('not found') || msg.includes('No such file')) {
          res.status(404).json({ error: `Artifact "${artifactName}" not found` })
        } else {
          res.status(500).json({ error: 'Failed to read artifact' })
        }
      }
    })
  )

  return router
}
