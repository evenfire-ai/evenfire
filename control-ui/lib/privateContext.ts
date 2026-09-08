import { createAgentContextName } from './agentContext'
import { apiSend } from './api'

export type PrivateContextDraft = {
  // Subject whose private context this is (agent name or connector server
  // name). Only feeds the generated RFC 1123 name.
  subject: string
  description: string
  mcpServers?: string[]
}

// A code-less 409 from a create-only POST is an unambiguous AlreadyExists name
// collision; a coded 409 (e.g. context_crd_outdated) must keep the server's
// own message. Mirrors the discrimination the agent wizard does at its create
// sites.
function isNameCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as Error & { status?: number }).status !== 409) return false
  const body = (error as Error & { body?: { code?: unknown } }).body
  const hasCode = typeof body?.code === 'string' && body.code.length > 0
  return !hasCode
}

/**
 * Creates a private context for the given subject and returns its name.
 *
 * The context is an implementation detail of the subject (agent or Marketplace
 * install), so the name is generated, never chosen by the user, and a rare
 * collision is hidden by retrying once with a fresh suffix before surfacing
 * the friendly failure message.
 */
export async function createPrivateContext(
  draft: PrivateContextDraft,
  failureMessage: string
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contextName = createAgentContextName(draft.subject)
    try {
      await apiSend('POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: draft.description,
          mcpServers: draft.mcpServers ?? [],
        },
      })
      return contextName
    } catch (error) {
      if (!isNameCollision(error)) throw error
      // Collision: retry once with a fresh suffix, then surface the friendly
      // message instead of the raw apiserver AlreadyExists text.
      if (attempt === 1) break
    }
  }

  throw new Error(failureMessage)
}
