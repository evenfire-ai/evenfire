import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import type { K8sGateway } from '../../k8s.js'
import { secretKeyNames } from '../../services/secretKeyNames.js'
import { toPublicSecretSummary } from '../../services/secretService.js'

function ccCredentialsSecretName(ccName: string): string {
  return `cc-${ccName}-credentials`
}

const ALLOWED_CREDENTIAL_KEYS = new Set([
  'telegram-bot-token',
  'slack-signing-secret',
  'slack-bot-token',
  'teams-app-password',
  'email-username',
  'email-password',
])

export function validateCommunicationChannelCredentials(
  data: unknown
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'request body must be a non-empty key-value map of credentials' }
  }
  const values = data as Record<string, unknown>
  if (Object.keys(values).length === 0) {
    return { ok: false, error: 'request body must be a non-empty key-value map of credentials' }
  }
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED_CREDENTIAL_KEYS.has(key)) {
      return { ok: false, error: `unsupported credential key "${key}"` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `credentials["${key}"] must be a string` }
    }
    const trimmed = value.trim()
    if (trimmed) cleaned[key] = trimmed
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: false, error: 'request body must be a non-empty key-value map of credentials' }
  }
  return { ok: true, values: cleaned }
}

export function registerCommunicationChannelCredentialsRoutes(
  router: Router,
  gateway: K8sGateway
): void {
  /**
   * Which credential keys this channel actually holds — names only, never values.
   *
   * The credentials panel used to infer presence from `credentialsSecretRef`
   * alone, so a Telegram-only channel rendered a populated Slack Signing Secret
   * field. Per-key names are the smallest answer that stops that lie.
   *
   * An absent Secret is 200 with `keys: []`, not 404: "no credentials yet" is a
   * normal state the panel renders, and a 404 would make every caller handle
   * two shapes for one meaning. An unreadable Secret (RBAC, apiserver failure)
   * propagates instead, so a denial is never laundered into "not configured".
   */
  router.get(
    '/admin/communication-channels/:name/credentials',
    enforceNamespace(config.communicationChannelsNamespace),
    asyncHandler(async (req, res) => {
      const ns = config.communicationChannelsNamespace
      const name = req.params.name

      const cc = (await gateway.getResource('communicationchannels', name, ns)) as {
        spec?: { credentialsSecretRef?: { name?: string } }
      }
      // Same resolution as the PUT: an operator-supplied ref wins, otherwise the
      // conventional name the PUT would create. Reading the ref matters — a
      // channel pointing at a custom Secret would otherwise report the keys of a
      // `cc-<name>-credentials` that does not exist, reintroducing the lie.
      const secretName = cc.spec?.credentialsSecretRef?.name || ccCredentialsSecretName(name)

      const keys = await secretKeyNames(gateway, secretName, ns)

      res.status(200).json({ name, secretName, namespace: ns, keys })
    })
  )

  router.put(
    '/admin/communication-channels/:name/credentials',
    enforceNamespace(config.communicationChannelsNamespace),
    asyncHandler(async (req, res) => {
      const ns = config.communicationChannelsNamespace
      const name = req.params.name
      const validation = validateCommunicationChannelCredentials(req.body)
      if (!validation.ok) {
        res.status(400).json({ error: validation.error })
        return
      }
      const data = validation.values

      const cc = (await gateway.getResource('communicationchannels', name, ns)) as {
        metadata?: { name?: string }
        spec?: Record<string, unknown> & {
          credentialsSecretRef?: { name?: string }
        }
      }
      const existingSecretName = cc.spec?.credentialsSecretRef?.name
      if (existingSecretName) {
        const merged = await gateway.mergeSecret({
          name: existingSecretName,
          namespace: ns,
          type: 'Opaque',
          stringData: data,
        })
        res.status(200).json({
          name,
          secretName: existingSecretName,
          namespace: ns,
          rotated: true,
          result: toPublicSecretSummary(merged),
        })
        return
      }

      const secretName = ccCredentialsSecretName(name)
      await gateway.createSecret({
        name: secretName,
        namespace: ns,
        type: 'Opaque',
        stringData: data,
      })
      const nextSpec: Record<string, unknown> = {
        ...(cc.spec ?? {}),
        credentialsSecretRef: { name: secretName },
      }
      const updated = await gateway.updateResource(
        'communicationchannels',
        name,
        { spec: nextSpec },
        ns
      )
      res.status(200).json({
        name,
        secretName,
        namespace: ns,
        rotated: false,
        result: updated,
      })
    })
  )

  router.delete(
    '/admin/communication-channels/:name/credentials/:key',
    enforceNamespace(config.communicationChannelsNamespace),
    asyncHandler(async (req, res) => {
      const ns = config.communicationChannelsNamespace
      const name = req.params.name
      const key = String(req.params.key || '').trim()
      if (!ALLOWED_CREDENTIAL_KEYS.has(key)) {
        res.status(400).json({ error: 'unsupported_credential_key' })
        return
      }
      const cc = (await gateway.getResource('communicationchannels', name, ns)) as {
        spec?: { credentialsSecretRef?: { name?: string } }
      }
      const secretName = cc.spec?.credentialsSecretRef?.name
      if (!secretName) {
        res.status(404).json({ error: 'credentials_secret_not_found' })
        return
      }
      await gateway.removeSecretKey({
        name: secretName,
        namespace: ns,
        key,
      })
      res.status(200).json({ name, secretName, namespace: ns, deletedKey: key })
    })
  )
}
