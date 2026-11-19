import type { IncomingMessage } from '../server'

/**
 * The Desktop says it draws fenced `mermaid` blocks as diagrams. Read only on
 * the rpc channel, whose envelope rpc-proxy builds and filters to known
 * values; a channel message never carries it.
 */
export function clientDrawsMermaid(
  message: Pick<IncomingMessage, 'channelType' | 'displayCapabilities'> | undefined
): boolean {
  return (
    message?.channelType === 'rpc' &&
    Array.isArray(message.displayCapabilities) &&
    message.displayCapabilities.includes('mermaid')
  )
}
