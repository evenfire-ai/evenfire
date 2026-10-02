import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { extractK8sError } from '../../http/k8sError.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type ConversationStoreHostSnapshot,
  type ConversationStoreOperation,
  ConversationStoreRequestError,
  parseConversationStoreRequest,
  validateConversationStoreRequest,
} from '../../services/hostConversationStoreService.js'

const logger = rootLogger.child({ module: 'admin-host-conversation-store' })
const HOST_REF = /^[a-z][a-z0-9-]{0,62}$/
const OPERATIONS: ReadonlySet<string> = new Set(['maintenance', 'prepare', 'adopt', 'release'])

export function createAdminHostConversationStoreRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/admin/hosts/:hostRef/conversation-store/:operation',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req: UiAuthedRequest, res) => {
      // app.ts authenticates the HttpOnly administrator session and current
      // account membership before this router. Runtime/delegated credentials
      // never establish this bound principal, even when their body claims admin.
      const principal = req.adminAuth
      if (!principal || principal.typ !== 'user' || principal.role !== 'admin' || !principal.sub) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      if (!HOST_REF.test(req.params.hostRef) || !OPERATIONS.has(req.params.operation)) {
        res.status(400).json({ error: 'invalid_conversation_store_target' })
        return
      }
      try {
        const host = (await gateway.getResource(
          'hosts',
          req.params.hostRef,
          config.hostsNamespace
        )) as ConversationStoreHostSnapshot
        const request = parseConversationStoreRequest(
          req.body,
          req.params.operation as ConversationStoreOperation,
          principal.sub,
          host
        )
        const disposition = validateConversationStoreRequest(host, request)
        if (disposition === 'new') {
          await gateway.patchHostConversationStoreRequest(req.params.hostRef, request, host)
          logger.info(
            {
              event: 'conversation_store_operator_request',
              operation: request.operation,
              hostRef: req.params.hostRef,
              requestId: request.requestId,
            },
            'Conversation store operator request submitted'
          )
        }
        res.status(disposition === 'new' ? 202 : 200).json({
          requestId: request.requestId,
          operation: request.operation,
          storageContract: request.storageContract,
          state: 'requested',
        })
      } catch (err) {
        if (err instanceof ConversationStoreRequestError) {
          res.status(err.status).json({ error: err.code })
          return
        }
        const status = extractK8sError(err)?.status
        if (status === 409 || status === 422) {
          res.status(409).json({ error: 'host_state_changed' })
          return
        }
        if (status === 404) {
          res.status(404).json({ error: 'host_not_found' })
          return
        }
        logger.error(
          { err, hostRef: req.params.hostRef },
          'Conversation store operator request failed'
        )
        res.status(503).json({ error: 'conversation_store_state_unavailable' })
      }
    })
  )
  return router
}
