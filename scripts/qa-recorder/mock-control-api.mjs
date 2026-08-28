#!/usr/bin/env node
// Mock control-api for QA-recorder journeys and UI e2e specs.
//
// Serves the exact wire contract control-ui consumes (see
// docs/features/control-ui-context-removal.md §9 and the endpoint inventory
// audited from control-ui/lib/api.ts) with in-memory state, so the REAL
// frontend can be driven end-to-end (and recorded) without a cluster.
// Evidence produced against this mock is mock-backed UI e2e — never call it
// a T2/runtime verdict.
//
// Usage: node scripts/qa-recorder/mock-control-api.mjs [port]
// Env:   MOCK_ADMIN_USER (default admin) — any password is accepted.
//
// Semantics emulated:
//   - cookie session (control_ui_admin_session), any credentials accepted
//   - resourceVersion counters; PUT with a stale metadata.resourceVersion → 409
//     {error:'conflict'} (absent RV = last-write-wins, like the legacy path)
//   - users/:id/contexts and teams/:id/contexts full-replace with
//     deletedContextIds history; contexts/:id/{users,teams} derived reverse-maps
//   - POST /registry/install creates the McpServer, ensures the context, and
//     adds the server to its allowlist (mirrors control-api behavior the
//     install-success copy depends on)
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.argv[2] ?? 8090)
const COOKIE = 'control_ui_admin_session=mock-session'
const ADMIN = { id: 'usr-admin', username: 'admin', email: 'admin@example.com', role: 'admin' }

let rvCounter = 0
const nextRv = () => `rv-${++rvCounter}`

// ── in-memory stores ────────────────────────────────────────────────────────
const users = [
  {
    id: ADMIN.id,
    email: ADMIN.email,
    name: 'Admin Admin',
    displayName: 'Admin Admin',
    controlAdminId: null,
    activeTeamCount: 0,
  },
]
const userContact = new Map(users.map(u => [u.id, { id: u.id, email: u.email, name: u.name, channels: { emails: [], slackUserNames: [], telegramIds: [] } }]))
const userContexts = new Map([[ADMIN.id, { contextIds: [], deletedContextIds: [] }]])
const userAgents = new Map([[ADMIN.id, []]])

const teams = []
const teamMembers = new Map()
const teamContexts = new Map()
const teamAgents = new Map()
const teamInvitations = new Map()

const hosts = new Map() // name → resource
const contexts = new Map() // name → resource
const mcpServers = new Map() // name → resource
const secrets = []
const budgets = []
const sharedFileSystems = [
  {
    metadata: { name: 'mock-workspace', namespace: 'workspace-files' },
    spec: { size: '5Gi', accessModes: ['ReadOnlyMany'] },
    status: { phase: 'Ready', capacity: '5Gi', mountedByContexts: [] },
  },
]

const registryEntries = [
  {
    id: 'mock-mcp-filesystem',
    name: 'mock-mcp-filesystem',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Mock local MCP entry for QA recorder journeys',
    author: 'evenfire',
    origin: 'mock',
    category: 'files',
    tags: ['mock'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { tools: ['read_file', 'write_file'] },
    latest: true,
    visibility: 'public',
  },
]

const llmModels = [
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true, source: 'seed', stale: false },
  { provider: 'zai', model: 'glm-5.1', enabled: true, source: 'seed', stale: false },
]

const recipes = new Map() // "<ns>/<name>" → resource

// ── helpers ─────────────────────────────────────────────────────────────────
const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(payload)
}
const readBody = req =>
  new Promise(resolve => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
const nameFrom = path => decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
const rfc1123 = /^[-a-z0-9]+$/

function resourceVersionGuard(resource, body) {
  const supplied = body?.metadata?.resourceVersion
  if (supplied !== undefined && supplied !== resource.metadata?.resourceVersion) {
    return { conflict: true }
  }
  return { conflict: false }
}

function contextUsers(id) {
  const items = []
  for (const [userId, access] of userContexts) {
    if ((access.contextIds ?? []).includes(id)) {
      const u = users.find(candidate => candidate.id === userId)
      if (u) items.push({ id: u.id, email: u.email, name: u.name, displayName: u.displayName })
    }
  }
  return { items }
}

function contextTeams(id) {
  const items = []
  for (const [teamId, access] of teamContexts) {
    if ((access.contextIds ?? []).includes(id)) {
      const t = teams.find(candidate => candidate.id === teamId)
      if (t) items.push({ id: t.id, name: t.name })
    }
  }
  return { items }
}

function putContextsMapping(map, key, contextIds, deletedKey) {
  const current = map.get(key) ?? { [deletedKey]: [] }
  const next = Array.isArray(contextIds) ? [...new Set(contextIds.map(String))] : []
  const removed = (current.contextIds ?? []).filter(id => !next.includes(id))
  const history = [...new Set([...(current[deletedKey] ?? []), ...removed])]
  const updated = { contextIds: next }
  updated[deletedKey] = history.filter(id => !next.includes(id))
  map.set(key, updated)
  return { ...updated, [key.includes('team') ? 'teamId' : 'userId']: key }
}

// ── router ──────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method
  const authed = (req.headers.cookie ?? '').includes(COOKIE.split('=')[0])

  if (!authed && !path.startsWith('/api/v1/admin/auth/login')) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req)
  if (process.env.MOCK_VERBOSE !== '0') {
    console.log(`[mock-control-api] ${method} ${path}${authed ? '' : ' (unauth)'}`)
  }
  const seg = path.replace(/^\/+/, '').split('/').filter(Boolean) // api v1 admin ...
  const rest = seg.slice(3).join('/') // after /api/v1/admin
  const M = method

  try {
    // ── auth ──
    if (rest === 'auth/login' && M === 'POST') {
      if (!body.username) return json(res, 400, { error: 'username required' })
      return json(res, 200, { me: { ...ADMIN, username: body.username } }, { 'Set-Cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` })
    }
    if (rest === 'auth/logout' && M === 'POST') return json(res, 200, { ok: true })
    if (rest === 'auth/me' && M === 'GET')
      return json(res, 200, { me: ADMIN, namespaces: { sandbox: 'sandbox', mcpServer: 'mcp-server' } })

    // ── users ──
    if (rest === 'users' && M === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const items = users.filter(u => !q || `${u.name} ${u.email} ${u.displayName}`.toLowerCase().includes(q))
      return json(res, 200, { items })
    }
    if (/^users\/[^/]+\/context$/.test(rest) && M === 'GET') {
      const id = nameFrom(rest.replace('/context', ''))
      return json(res, 200, userContact.get(id) ?? { id, email: '', name: '', channels: { emails: [], slackUserNames: [], telegramIds: [] } })
    }
    if (/^users\/[^/]+\/context$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/context', ''))
      userContact.set(id, { ...(userContact.get(id) ?? { id }), ...body })
      return json(res, 200, userContact.get(id))
    }
    if (/^users\/[^/]+\/contexts$/.test(rest) && M === 'GET') {
      const id = nameFrom(rest.replace('/contexts', ''))
      return json(res, 200, userContexts.get(id) ?? { userId: id, contextIds: [], deletedContextIds: [] })
    }
    if (/^users\/[^/]+\/contexts$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/contexts', ''))
      return json(res, 200, putContextsMapping(userContexts, id, body.contextIds, 'deletedContextIds'))
    }
    if (/^users\/[^/]+\/agents$/.test(rest) && M === 'GET') {
      const id = nameFrom(rest.replace('/agents', ''))
      return json(res, 200, { agentNames: userAgents.get(id) ?? [], deletedAgentNames: [] })
    }
    if (/^users\/[^/]+\/agents$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/agents', ''))
      userAgents.set(id, Array.isArray(body.agentNames) ? body.agentNames : [])
      return json(res, 200, { agentNames: userAgents.get(id), deletedAgentNames: [] })
    }
    if (/^users\/[^/]+\/teams$/.test(rest) && M === 'GET')
      return json(res, 200, { items: [] })

    // ── teams ──
    if (rest === 'teams' && M === 'GET')
      return json(res, 200, { items: teams.map(t => ({ id: t.id, name: t.name, memberCount: teamMembers.get(t.id)?.length ?? 0 })) })
    if (rest === 'teams' && M === 'POST') {
      if (!body.name) return json(res, 400, { error: 'name required' })
      const team = { id: `team-${randomUUID().slice(0, 8)}`, name: String(body.name) }
      teams.push(team)
      teamMembers.set(team.id, [])
      teamContexts.set(team.id, { contextIds: [], deletedContextIds: [] })
      teamAgents.set(team.id, [])
      teamInvitations.set(team.id, [])
      return json(res, 200, team)
    }
    if (/^teams\/[^/]+$/.test(rest) && M === 'GET') {
      const id = nameFrom(rest)
      const team = teams.find(t => t.id === id)
      return team ? json(res, 200, team) : json(res, 404, { error: 'not found' })
    }
    if (/^teams\/[^/]+$/.test(rest) && M === 'DELETE') {
      const id = nameFrom(rest)
      const idx = teams.findIndex(t => t.id === id)
      if (idx === -1) return json(res, 404, { error: 'not found' })
      teams.splice(idx, 1)
      return json(res, 200, { deleted: true, id })
    }
    if (/^teams\/[^/]+\/members$/.test(rest) && M === 'GET')
      return json(res, 200, { items: teamMembers.get(nameFrom(rest.replace('/members', ''))) ?? [] })
    if (/^teams\/[^/]+\/agents$/.test(rest) && M === 'GET')
      return json(res, 200, { agentNames: teamAgents.get(nameFrom(rest.replace('/agents', ''))) ?? [], deletedAgentNames: [] })
    if (/^teams\/[^/]+\/agents$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/agents', ''))
      teamAgents.set(id, Array.isArray(body.agentNames) ? body.agentNames : [])
      return json(res, 200, { agentNames: teamAgents.get(id), deletedAgentNames: [] })
    }
    if (/^teams\/[^/]+\/contexts$/.test(rest) && M === 'GET') {
      const id = nameFrom(rest.replace('/contexts', ''))
      return json(res, 200, teamContexts.get(id) ?? { teamId: id, contextIds: [], deletedContextIds: [] })
    }
    if (/^teams\/[^/]+\/contexts$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/contexts', ''))
      const updated = putContextsMapping(teamContexts, id, body.contextIds, 'deletedContextIds')
      return json(res, 200, { teamId: id, ...updated })
    }
    if (/^teams\/[^/]+\/invitations$/.test(rest) && M === 'GET')
      return json(res, 200, { items: teamInvitations.get(nameFrom(rest.replace('/invitations', ''))) ?? [] })
    if (/^teams\/[^/]+\/name$/.test(rest) && M === 'PUT') {
      const id = nameFrom(rest.replace('/name', ''))
      const team = teams.find(t => t.id === id)
      if (!team) return json(res, 404, { error: 'not found' })
      team.name = String(body.name ?? team.name)
      return json(res, 200, team)
    }

    // ── hosts ──
    if (rest === 'hosts' && M === 'GET') return json(res, 200, { items: [...hosts.values()] })
    if (rest === 'hosts' && M === 'POST') {
      const name = String(body?.metadata?.name ?? '')
      if (!rfc1123.test(name)) return json(res, 422, { errors: [{ field: 'metadata.name', message: 'invalid name' }] })
      if (hosts.has(name)) return json(res, 409, { error: 'already exists' })
      const host = { ...body, metadata: { ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      hosts.set(name, host)
      return json(res, 201, host)
    }
    if (/^hosts\/[^/]+\/detail$/.test(rest) && M === 'GET') {
      const name = nameFrom(rest.replace('/detail', ''))
      const host = hosts.get(name)
      if (!host) return json(res, 404, { error: 'not found' })
      const ref = String(host.spec?.contextRef ?? '')
      const linked = ref ? [...contexts.values()].filter(c => String(c.metadata?.name) === ref || String(c.spec?.contextId) === ref) : []
      return json(res, 200, { host, contexts: linked, secrets, users: [], teams: [], agentUsers: [], agentTeams: [] })
    }
    if (/^hosts\/[^/]+$/.test(rest) && M === 'GET') {
      const host = hosts.get(nameFrom(rest))
      return host ? json(res, 200, host) : json(res, 404, { error: 'not found' })
    }
    if (/^hosts\/[^/]+$/.test(rest) && M === 'PUT') {
      const name = nameFrom(rest)
      const host = hosts.get(name)
      if (!host) return json(res, 404, { error: 'not found' })
      if (resourceVersionGuard(host, body).conflict) return json(res, 409, { error: 'conflict' })
      const updated = { ...host, ...body, metadata: { ...(host.metadata ?? {}), ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      hosts.set(name, updated)
      return json(res, 200, updated)
    }
    if (/^hosts\/[^/]+$/.test(rest) && M === 'DELETE') {
      hosts.delete(nameFrom(rest))
      return json(res, 200, { deleted: true })
    }

    // ── contexts ──
    if (rest === 'contexts' && M === 'GET') return json(res, 200, { items: [...contexts.values()] })
    if (rest === 'contexts' && M === 'POST') {
      const name = String(body?.metadata?.name ?? '')
      if (!rfc1123.test(name)) return json(res, 422, { errors: [{ field: 'metadata.name', message: 'invalid name' }] })
      if (contexts.has(name)) return json(res, 409, { error: 'already exists' })
      const context = { ...body, metadata: { ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      contexts.set(name, context)
      return json(res, 201, context)
    }
    if (/^contexts\/[^/]+\/users$/.test(rest) && M === 'GET') return json(res, 200, contextUsers(nameFrom(rest.replace('/users', ''))))
    if (/^contexts\/[^/]+\/teams$/.test(rest) && M === 'GET') return json(res, 200, contextTeams(nameFrom(rest.replace('/teams', ''))))
    if (/^contexts\/[^/]+$/.test(rest) && M === 'GET') {
      const name = nameFrom(rest)
      const byId = [...contexts.values()].find(c => String(c.spec?.contextId) === name)
      const context = contexts.get(name) ?? byId
      return context ? json(res, 200, context) : json(res, 404, { error: 'not found' })
    }
    if (/^contexts\/[^/]+$/.test(rest) && M === 'PUT') {
      const name = nameFrom(rest)
      let context = contexts.get(name)
      if (!context) {
        const byId = [...contexts.values()].find(c => String(c.spec?.contextId) === name)
        context = byId
      }
      if (!context) return json(res, 404, { error: 'not found' })
      if (resourceVersionGuard(context, body).conflict) return json(res, 409, { error: 'conflict' })
      const key = context.metadata?.name ?? name
      const updated = { ...context, ...body, metadata: { ...(context.metadata ?? {}), ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      contexts.set(key, updated)
      return json(res, 200, updated)
    }
    if (/^contexts\/[^/]+$/.test(rest) && M === 'DELETE') {
      const name = nameFrom(rest)
      const byId = [...contexts.values()].find(c => String(c.spec?.contextId) === name)
      contexts.delete(name)
      if (byId) contexts.delete(byId.metadata?.name ?? '')
      return json(res, 200, { deleted: true })
    }

    // ── mcp-servers ──
    if (rest === 'mcp-servers' && M === 'GET') return json(res, 200, { items: [...mcpServers.values()] })
    if (rest === 'mcp-servers' && M === 'POST') {
      const name = String(body?.metadata?.name ?? '')
      if (!rfc1123.test(name)) return json(res, 422, { errors: [{ field: 'metadata.name', message: 'invalid name' }] })
      if (mcpServers.has(name)) return json(res, 409, { error: 'already exists' })
      const server = { ...body, metadata: { ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      mcpServers.set(name, server)
      return json(res, 201, server)
    }
    if (/^mcp-servers\/[^/]+$/.test(rest) && M === 'GET') {
      const server = mcpServers.get(nameFrom(rest))
      return server ? json(res, 200, server) : json(res, 404, { error: 'not found' })
    }
    if (/^mcp-servers\/[^/]+$/.test(rest) && M === 'PUT') {
      const name = nameFrom(rest)
      const server = mcpServers.get(name)
      if (!server) return json(res, 404, { error: 'not found' })
      if (resourceVersionGuard(server, body).conflict) return json(res, 409, { error: 'conflict' })
      const updated = { ...server, ...body, metadata: { ...(server.metadata ?? {}), ...(body.metadata ?? {}), resourceVersion: nextRv() } }
      mcpServers.set(name, updated)
      return json(res, 200, updated)
    }
    if (/^mcp-servers\/[^/]+$/.test(rest) && M === 'DELETE') {
      mcpServers.delete(nameFrom(rest))
      return json(res, 200, { deleted: true })
    }

    // ── secrets ──
    if (rest === 'secrets' && M === 'GET') return json(res, 200, { items: secrets.map(s => ({ name: s.name, keys: Object.keys(s.stringData ?? {}) })) })
    if (rest === 'secrets' && M === 'POST') {
      const name = String(body.name ?? '')
      if (!name) return json(res, 400, { error: 'name required' })
      secrets.push({ name, stringData: body.stringData ?? {} })
      return json(res, 201, { name })
    }
    if (/^secrets\/[^/]+$/.test(rest) && M === 'DELETE') {
      const name = nameFrom(rest)
      const idx = secrets.findIndex(s => s.name === name)
      if (idx >= 0) secrets.splice(idx, 1)
      return json(res, 200, { deleted: true })
    }
    if (rest === 'mcp-secrets' && M === 'POST') return json(res, 201, { name: String(body.name ?? ''), namespace: 'mcp-server' })
    if (/^mcp-secrets\/[^/]+$/.test(rest) && M === 'PUT') {
      const secretName = decodeURIComponent(nameFrom(rest))
      const affectedConnectors = []
      for (const [name, server] of mcpServers) {
        if (String(server.spec?.envSecret?.name ?? '') === secretName) {
          affectedConnectors.push(name)
          server.status = {
            conditions: [
              {
                type: 'DeploymentReady',
                status: 'True',
                reason: 'RotationComplete',
                message: 'Mock rotation rollout finished',
                lastTransitionTime: new Date(Date.now() + 1_000).toISOString(),
              },
            ],
          }
        }
      }
      return json(res, 200, {
        name: secretName,
        keys: Object.keys(body.data ?? {}),
        affectedConnectors,
      })
    }

    // ── registry ──
    if (rest === 'registry/entries' && M === 'GET')
      return json(res, 200, { data: registryEntries, meta: { total: registryEntries.length } })
    if (/^registry\/entries\/[^/]+\/versions\/[^/]+$/.test(rest) && M === 'GET') {
      const entry = registryEntries[0]
      return entry ? json(res, 200, entry) : json(res, 404, { error: 'not found' })
    }
    if (/^registry\/entries\/[^/]+\/versions\/[^/]+\/credential-schema$/.test(rest) && M === 'GET')
      return json(res, 200, { required: false, authType: 'api-key', keys: [] })
    if (rest === 'registry/catalog' && M === 'GET')
      return json(res, 200, { data: registryEntries, categories: ['files'], installed: { catalogKeys: [], serverNames: [...mcpServers.keys()], recipeKeys: [] } })
    if (rest === 'registry/install' && M === 'POST') {
      const serverName = String(body.serverName ?? body.registryEntryName)
      const entry = registryEntries.find(e => e.name === body.registryEntryName) ?? registryEntries[0]
      if (!entry) return json(res, 404, { error: 'entry not found' })
      mcpServers.set(serverName, {
        metadata: { name: serverName, resourceVersion: nextRv(), labels: { 'clerum.io/managed-by': 'control-api' }, annotations: { 'clerum.io/catalog-id': entry.name, 'clerum.io/catalog-version': body.registryEntryVersion ?? entry.version } },
        spec: { image: 'clerum/mock-mcp-server:test', contextRef: body.contextRef, enabled: true, managed: true, transport: { type: 'streamableHttp', port: 3000, url: `http://${serverName}.mcp-server.svc.cluster.local:3000/mcp` } },
      })
      const ref = String(body.contextRef ?? '')
      const existing = contexts.get(ref)
      if (existing) {
        const servers = new Set([...(existing.spec?.mcpServers ?? []), serverName])
        existing.spec = { ...existing.spec, mcpServers: [...servers] }
        existing.metadata = { ...existing.metadata, resourceVersion: nextRv() }
      } else if (ref) {
        contexts.set(ref, { metadata: { name: ref, resourceVersion: nextRv() }, spec: { contextId: ref, description: `Connector access scope for ${serverName}`, mcpServers: [serverName] } })
      }
      return json(res, 201, { installed: true, serverName, namespace: 'mcp-server', contextRef: ref })
    }

    // ── budgets ──
    if (rest === 'budgets' && M === 'GET') return json(res, 200, { rows: budgets })
    if (rest === 'budgets' && M === 'POST') {
      if (!body.name || !body.unit || !body.limit_amount || !body.period) return json(res, 400, { error: 'invalid budget' })
      const row = { id: randomUUID(), enabled: true, spent: 0, remaining: body.limit_amount, unpriced: false, ...body }
      budgets.push(row)
      return json(res, 201, row)
    }
    if (/^budgets\/[^/]+$/.test(rest) && M === 'DELETE') {
      const id = nameFrom(rest)
      const idx = budgets.findIndex(b => b.id === id)
      if (idx >= 0) budgets.splice(idx, 1)
      return json(res, 200, { deleted: true })
    }

    // ── misc lists the UI boots with ──
    if (rest === 'shared-filesystems' && M === 'GET') return json(res, 200, { items: sharedFileSystems })
    if (/^shared-filesystems\/[^/]+$/.test(rest) && M === 'GET') {
      const name = nameFrom(rest)
      const sfs = sharedFileSystems.find(s => s.metadata?.name === name)
      return sfs ? json(res, 200, sfs) : json(res, 404, { error: 'not found' })
    }
    if (/^shared-filesystems\/[^/]+\/proxy\/v1\/files$/.test(rest) && M === 'GET')
      return json(res, 200, { entries: [] })
    if (rest === 'pending-invitations' && M === 'GET') return json(res, 200, { items: [] })
    if (rest === 'attention' && M === 'GET') return json(res, 200, { items: [] })
    if (rest === 'settings/me' && M === 'GET')
      return json(res, 200, { theme: 'dark', notifications: {} })
    if (rest === 'llm-prices' && M === 'GET') return json(res, 200, { items: [] })
    if (rest === 'llm-prices/unpriced' && M === 'GET') return json(res, 200, { models: [] })
    if (rest === 'recipe-secrets' && M === 'GET') return json(res, 200, { items: [] })
    if (/^workflows\/[^/]+\/[^/]+\/runs$/.test(rest) && M === 'GET')
      return json(res, 200, { items: [] })
    if (/^recipes\/[^/]+\/pods$/.test(rest) && M === 'GET')
      return json(res, 200, { pods: [] })
    if (/^recipes\/[^/]+\/status$/.test(rest) && M === 'GET')
      return json(res, 200, { conditions: [] })
    if (/^recipes\/[^/]+\/artifacts$/.test(rest) && M === 'GET')
      return json(res, 200, { items: [] })
    if (/^mcp-secrets\/[^/]+$/.test(rest) && M === 'DELETE') return json(res, 200, { deleted: true })
    if (/^recipes\/[^/]+$/.test(rest) && M === 'GET') {
      const name = decodeURIComponent(nameFrom(rest))
      const recipe = [...recipes.values()].find(r => String(r.metadata?.name) === name)
      return recipe ? json(res, 200, recipe) : json(res, 404, { error: 'not found' })
    }
    if (/^recipes\/[^/]+$/.test(rest) && M === 'PUT') {
      const name = decodeURIComponent(nameFrom(rest))
      const key = [...recipes.keys()].find(k => k.endsWith(`/${name}`)) ?? `default/${name}`
      recipes.set(key, body)
      return json(res, 200, body)
    }
    if (/^recipes\/[^/]+$/.test(rest) && M === 'DELETE') {
      const name = decodeURIComponent(nameFrom(rest))
      for (const k of [...recipes.keys()]) if (k.endsWith(`/${name}`)) recipes.delete(k)
      return json(res, 200, { deleted: true })
    }
    if (rest === 'invitations' && M === 'POST') {
      const invitation = {
        id: `inv-${randomUUID().slice(0, 8)}`,
        team_id: body.teams?.[0]?.teamId ?? null,
        invitee_name: body.name ?? null,
        email: body.email ?? '',
        role: body.role ?? 'member',
        status: 'pending',
      }
      if (invitation.team_id && teamInvitations.has(invitation.team_id)) {
        teamInvitations.get(invitation.team_id).push(invitation)
      }
      return json(res, 201, invitation)
    }
    if (rest === 'settings/bridge-status' && M === 'GET') return json(res, 200, {})
    if (rest === 'registry/publish-scope' && M === 'GET') return json(res, 200, {})
    if (rest === 'registry/keys' && M === 'GET') return json(res, 200, { items: [], keys: [] })
    if (rest === 'registry/images' && M === 'GET') return json(res, 200, { org: '', images: [] })
    if (rest === 'registry/connect' && M === 'GET') return json(res, 200, { connected: false })

    // ── recipes (stored verbatim; editor validation is client-side) ──
    if (rest === 'recipes/validate' && M === 'POST')
      return json(res, 200, { valid: true, issues: [] })
    if (rest === 'recipes' && M === 'POST') {
      const ns = String(body?.metadata?.namespace ?? 'default')
      const name = String(body?.metadata?.name ?? '')
      if (!name) return json(res, 400, { error: 'metadata.name required' })
      const recipe = { ...body, metadata: { namespace: ns, ...(body.metadata ?? {}) } }
      recipes.set(`${ns}/${name}`, recipe)
      return json(res, 201, recipe)
    }
    if (/^recipes\/[^/]+\/[^/]+$/.test(rest) && M === 'GET') {
      const [ns, name] = rest.split('/').slice(1)
      const recipe = recipes.get(`${decodeURIComponent(ns)}/${decodeURIComponent(name)}`)
      return recipe ? json(res, 200, recipe) : json(res, 404, { error: 'not found' })
    }
    if (/^recipes\/[^/]+\/[^/]+$/.test(rest) && M === 'PUT') {
      const [ns, name] = rest.split('/').slice(1)
      recipes.set(`${decodeURIComponent(ns)}/${decodeURIComponent(name)}`, body)
      return json(res, 200, body)
    }
    if (/^recipes\/[^/]+\/[^/]+$/.test(rest) && M === 'DELETE') {
      const [ns, name] = rest.split('/').slice(1)
      recipes.delete(`${decodeURIComponent(ns)}/${decodeURIComponent(name)}`)
      return json(res, 200, { deleted: true })
    }
    if (rest === 'recipes' && M === 'GET')
      return json(res, 200, { items: [...recipes.values()] })
    if (rest === 'profile-admin/overview' && M === 'GET')
      return json(res, 200, {
        teams: teams.map(t => ({ id: t.id, name: t.name })),
        users: users.map(u => ({ id: u.id, email: u.email, name: u.name, displayName: u.displayName })),
        pendingInvitations: [],
        teamAgentCounts: Object.fromEntries(teams.map(t => [t.id, teamAgents.get(t.id)?.length ?? 0])),
        teamContextCounts: Object.fromEntries(teams.map(t => [t.id, teamContexts.get(t.id)?.contextIds?.length ?? 0])),
      })
    if (rest === 'llm-models' && M === 'GET') return json(res, 200, { rows: llmModels })
    if (rest === 'communication-channels' && M === 'GET') return json(res, 200, { items: [] })
    if (rest === 'recipes' && M === 'GET') return json(res, 200, { items: [] })
    if (rest === 'workflow-recipes' && M === 'GET') return json(res, 200, { items: [] })

    // Unknown endpoint: log loudly so missing stubs are obvious, then 404.
    console.log(`[mock-control-api] UNHANDLED ${M} ${path}`)
    return json(res, 404, { error: `no mock for ${M} ${path}` })
  } catch (err) {
    console.error(`[mock-control-api] ERROR ${M} ${path}:`, err)
    return json(res, 500, { error: 'mock error' })
  }
})

server.listen(PORT, () => {
  console.log(`[mock-control-api] listening on all local interfaces, port ${PORT} (any credentials accepted; mock-backed UI e2e only)`)
})
