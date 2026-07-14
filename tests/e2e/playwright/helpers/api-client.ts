/**
 * Thin API client for test helpers — wraps fetch against control-api.
 * Used to set up / tear down test data without going through the UI.
 */

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'

function adminHeaders(): Record<string, string> {
  const token = process.env.PLAYWRIGHT_ADMIN_TOKEN ?? ''
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
}
