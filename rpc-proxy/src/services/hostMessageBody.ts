import type { TraceContextV1 } from '../traceContext.js'
import type { HostRuntimeMessageRequest } from './mcpHostRestService.js'

/**
 * Metadata the proxy derives from the verified edge claims for the Host
 * (`rpcInvocationContext`). Passed in rather than recomputed here so this
 * module stays free of auth concerns.
 */
export type RpcInvocationMetadata = {
  accessScope: 'team' | 'user'
  teamId?: string
}

export type HostRuntimeMessageBodyInput = {
  /** Client body. Only the allow-listed fields read below ever reach the Host. */
  body: HostRuntimeMessageRequest
  hostRef: string
  /** Verified edge caller (`sub`). Never the body's `sender`. */
  sender: string
  /** Per-request idempotency identity; identical across the wake retry. */
  deliveryMessageId: string
  desktopSessionId: string | undefined
  metadata: RpcInvocationMetadata
  traceContext: TraceContextV1
}

/**
 * The single rpc-proxy → mcp-host message envelope: channel, sender, host,
 * metadata, thread and trace are server-derived, and the body is an explicit
 * field allow-list, so an unlisted field is dropped rather than forwarded.
 *
 * Kept pure and exported because the Host's ingress test consumes the same
 * committed vector as the proxy (R2-L7): a field added or dropped here without
 * a matching Host change turns both suites red instead of producing a 500 on
 * the first Retry after deploy.
 */
export function buildHostRuntimeMessageRequest(
  input: HostRuntimeMessageBodyInput
): HostRuntimeMessageRequest {
  const { body, hostRef, sender, deliveryMessageId, desktopSessionId, metadata, traceContext } =
    input
  return {
    content: body.content,
    channelType: 'rpc',
    channelId: hostRef,
    hostRef,
    sender,
    messageId: deliveryMessageId,
    metadata,
    threadId: desktopSessionId,
    attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
    ...(body.fileReferences === undefined ? {} : { fileReferences: body.fileReferences }),
    ...(body.modelSelectionRevision === undefined
      ? {}
      : { modelSelectionRevision: body.modelSelectionRevision }),
    traceContext,
    // Optional piggybacked per-session model. Trimmed/empty values are omitted.
    ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : {}),
  }
}
