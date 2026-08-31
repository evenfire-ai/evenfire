/**
 * Thin API client for test helpers — wraps fetch against control-api.
 * Used to set up / tear down test data without going through the UI.
 */
import { adminSessionCookieHeader } from './session-cookie'

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...adminSessionCookieHeader(),
  }
}

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL_API_URL}${path}`, {
    method,
    headers: adminHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export type AdminUser = {
  id: string
  name: string
  email: string
  displayName?: string
  activeTeamCount: number
}

export type TeamListItem = {
  id: string
  name: string
  memberCount: number
}

export type HostCr = {
  metadata?: { name?: string }
  spec?: Record<string, unknown> & {
    channels?: string[]
    lifecycle?: { stateless?: boolean }
    workflowControl?: { scopes?: string[] }
  }
  status?: {
    lifecycle?: { state?: string; reason?: string }
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
  }
}

export const controlApi = {
  async validateRecipe(recipe: unknown): Promise<{ valid: boolean; errors?: unknown[] }> {
    return apiFetch<{ valid: boolean; errors?: unknown[] }>(
      'POST',
      '/api/v1/admin/recipes/validate',
      recipe
    )
  },

  async createRecipe(recipe: unknown): Promise<unknown> {
    return apiFetch<unknown>('POST', '/api/v1/admin/recipes', recipe)
  },

  async updateRecipe(name: string, recipe: unknown): Promise<unknown> {
    return apiFetch<unknown>('PUT', `/api/v1/admin/recipes/${encodeURIComponent(name)}`, recipe)
  },

  async getUsers(query = ''): Promise<{ items: AdminUser[] }> {
    const qs = query ? `?query=${encodeURIComponent(query)}` : ''
    return apiFetch<{ items: AdminUser[] }>('GET', `/api/v1/admin/users${qs}`)
  },

  async getTeams(): Promise<{ items: TeamListItem[] }> {
    return apiFetch<{ items: TeamListItem[] }>('GET', '/api/v1/admin/teams')
  },

  async getUserById(userId: string): Promise<AdminUser> {
    return apiFetch<AdminUser>('GET', `/api/v1/admin/users/${userId}`)
  },

  async getHosts(): Promise<{ items: unknown[] }> {
    return apiFetch<{ items: unknown[] }>('GET', '/api/v1/admin/hosts')
  },

  async getContexts(): Promise<{ items: unknown[] }> {
    return apiFetch<{ items: unknown[] }>('GET', '/api/v1/admin/contexts')
  },

  async deleteRecipe(name: string): Promise<void> {
    await apiFetch<unknown>('DELETE', `/api/v1/admin/recipes/${encodeURIComponent(name)}`)
  },

  async getRecipe(name: string): Promise<unknown> {
    return apiFetch<unknown>('GET', `/api/v1/admin/recipes/${encodeURIComponent(name)}`)
  },

  async ensureRecipeDeleted(name: string): Promise<void> {
    try {
      await this.deleteRecipe(name)
    } catch {
      // ignore — recipe may not exist (404) or cluster may be unreachable
    }
  },

  async getHost(name: string): Promise<HostCr> {
    return apiFetch<HostCr>('GET', `/api/v1/admin/hosts/${encodeURIComponent(name)}`)
  },

  async createHost(host: unknown): Promise<unknown> {
    return apiFetch<unknown>('POST', '/api/v1/admin/hosts', host)
  },

  /**
   * RV-absent legacy update (last-write-wins) — mirrors an API caller that
   * does not send metadata.resourceVersion. The AP-6 conflict test uses it
   * as the legitimate out-of-band second actor.
   */
  async updateHost(name: string, host: unknown): Promise<unknown> {
    return apiFetch<unknown>('PUT', `/api/v1/admin/hosts/${encodeURIComponent(name)}`, host)
  },

  async deleteHost(name: string): Promise<void> {
    await apiFetch<unknown>('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(name)}`)
  },

  async ensureHostDeleted(name: string): Promise<void> {
    try {
      await this.deleteHost(name)
    } catch {
      // ignore — host may not exist (404) or cluster may be unreachable
    }
  },

  async deleteContext(name: string): Promise<void> {
    await apiFetch<unknown>('DELETE', `/api/v1/admin/contexts/${encodeURIComponent(name)}`)
  },

  /**
   * Create a control-api-managed host secret (labeled clerum.io/host-secret,
   * the label the Host wizard's "Use existing secret" picker lists). Mirrors
   * the wizard's own POST /api/v1/admin/secrets payload.
   */
  async createHostSecret(name: string, stringData: Record<string, string>): Promise<void> {
    await apiFetch<unknown>('POST', '/api/v1/admin/secrets', {
      name,
      namespace: 'mcp-host',
      labels: { 'clerum.io/host-secret': 'true' },
      stringData,
    })
  },

  async ensureSecretDeleted(name: string): Promise<void> {
    try {
      await apiFetch<unknown>('DELETE', `/api/v1/admin/secrets/${encodeURIComponent(name)}`)
    } catch {
      // ignore — secret may not exist (404) or cluster may be unreachable
    }
  },

  async ensureContextDeleted(name: string): Promise<void> {
    try {
      await this.deleteContext(name)
    } catch {
      // ignore — context may not exist (404) or cluster may be unreachable
    }
  },

  async listCodexConnections(): Promise<
    Array<{
      connectionKey: string
      displayName?: string
      status: string
      catalogRevision: number
      assignedHosts?: Array<{ name: string }>
    }>
  > {
    const body = await apiFetch<{
      connections?: Array<{
        connectionKey: string
        displayName?: string
        status: string
        catalogRevision: number
        assignedHosts?: Array<{ name: string }>
      }>
    }>('GET', '/api/v1/admin/llm/providers/codex-subscription/connections')
    return body.connections ?? []
  },

  async createCommunicationChannel(channel: unknown): Promise<unknown> {
    return apiFetch<unknown>('POST', '/api/v1/admin/communication-channels', channel)
  },

  async deleteCommunicationChannel(name: string): Promise<void> {
    await apiFetch<unknown>(
      'DELETE',
      `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`
    )
  },

  async ensureCommunicationChannelDeleted(name: string): Promise<void> {
    try {
      await this.deleteCommunicationChannel(name)
    } catch {
      // ignore — channel may not exist (404) or cluster may be unreachable
    }
  },
}
