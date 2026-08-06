/**
 * The capability catalog (spec §6).
 *
 * One immutable descriptor per capability. `minimize` is MANDATORY, not an
 * optional passthrough: adding a capability must force an explicit decision
 * about what the plugin sees. A `minimize` that returns its input unchanged is
 * a review finding, not a shortcut.
 *
 * Every provider reaches upstream through the user's OWN session (the narrow
 * `PluginSdkDataSource` view of AppService), so control-api authorizes exactly
 * as it does for the Desktop's own pages. Consent is an additional gate on top
 * of the user's ACL, never a substitute for it.
 */
import type {
  GfsAccessibleResourcesPage,
  GfsChildrenPage,
  ResolvedGfsResource,
} from './gfs/uriHandler.js'
import type { PluginCapabilityTier, PluginTheme } from './pluginSdkProtocol.js'
import type {
  AccessCatalog,
  AgentWithMcpServers,
  RpcAllowedServersResult,
  SessionState,
} from './types.js'

/** Image bytes ceiling, matching the Desktop's own GFS preview limit. */
export const PLUGIN_GFS_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const PLUGIN_GFS_TEXT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Renderable image types. `image/svg+xml` is deliberately ABSENT: an SVG in an
 * `<img>` cannot execute script, but it can pull external resources and is a
 * standing parser-bug surface. A plugin that wants vector art ships it in its
 * own bundle.
 */
export const PLUGIN_GFS_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
] as const

/** Magic-byte prefixes, so a `.png` whose bytes are not a PNG is refused. */
const IMAGE_MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    test: b =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: b => b.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  {
    mime: 'image/webp',
    test: b =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'image/avif',
    test: b =>
      b.subarray(4, 8).toString('ascii') === 'ftyp' &&
      b.subarray(8, 12).toString('ascii').startsWith('avi'),
  },
]

export function detectImageMime(bytes: Buffer): string | null {
  for (const entry of IMAGE_MAGIC) {
    try {
      if (entry.test(bytes)) return entry.mime
    } catch {
      // A file shorter than a magic prefix simply is not that format.
    }
  }
  return null
}

/** The narrow slice of AppService a provider may touch. Keeps tests Electron-free. */
export interface PluginSdkDataSource {
  getSessionState(): Promise<SessionState>
  listMyAgents(): Promise<AgentWithMcpServers[]>
  getAccessCatalog(): Promise<AccessCatalog>
  listAccessibleMcpServers(): Promise<RpcAllowedServersResult>
  listAccessibleGfsResources(drive?: string, cursor?: string): Promise<GfsAccessibleResourcesPage>
  listGfsChildren(resourceId: string, drive?: string, cursor?: string): Promise<GfsChildrenPage>
  downloadGfsUri(uri: string): Promise<{ resource: ResolvedGfsResource; bytes: ArrayBuffer }>
  getPluginTheme(): PluginTheme
  showPluginNotification(input: {
    pluginId: string
    pluginTitle: string
    title: string
    body?: string
    ref?: string
  }): Promise<{ delivered: boolean; reason?: 'suppressed' | 'unsupported' }>
}

export type ProviderContext = {
  source: PluginSdkDataSource
  pluginId: string
  pluginTitle: string
  userId: string
}

export type CapabilityDescriptor = {
  id: string
  /** Bump when the payload widens; older grants stop covering it (spec §9.6). */
  descriptorVersion: number
  requiresConsent: boolean
  consent: {
    title: string
    dataDescription: string
    tier: PluginCapabilityTier
  }
  limits: { perMinute: number; perHour: number; maxResponseBytes: number }
  /** Milliseconds a result may be reused. 0 disables caching. */
  cacheTtlMs: number
  validate: (raw: unknown) => Record<string, unknown>
  run: (ctx: ProviderContext, params: Record<string, unknown>) => Promise<unknown>
}

export class CapabilityInputError extends Error {}
export class CapabilityNotFoundError extends Error {}
export class CapabilityTooLargeError extends Error {}

function noParams(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityInputError('this capability takes no parameters')
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length > 0) {
    throw new CapabilityInputError(`unexpected parameter: ${keys[0]}`)
  }
  return {}
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new CapabilityInputError(`${field} must be a string`)
  if (value.length > maxLength) throw new CapabilityInputError(`${field} is too long`)
  return value
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalString(value, field, maxLength)
  if (!parsed) throw new CapabilityInputError(`${field} is required`)
  return parsed
}

function allowKeys(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityInputError('params must be an object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new CapabilityInputError(`unexpected parameter: ${key}`)
  }
  return record
}

/** Strip control characters from user-visible plugin-supplied text. */
function plainText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

export const CAPABILITIES: Record<string, CapabilityDescriptor> = {
  'identity.read': {
    id: 'identity.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See who you are',
      dataDescription: 'Your name, email address, and user id.',
      tier: 'personal',
    },
    limits: { perMinute: 10, perHour: 60, maxResponseBytes: 4 * 1024 },
    cacheTtlMs: 60_000,
    validate: noParams,
    run: async ctx => {
      const state = await ctx.source.getSessionState()
      if (!state.authenticated || !state.me) throw new CapabilityNotFoundError('no session')
      // `picture` is omitted on purpose: it is a remote URL and the embed CSP is
      // `img-src 'self' data:`, so the plugin could not render it — shipping it
      // would leak an identifier for zero benefit (spec §6.1).
      return { userId: state.me.id, email: state.me.email, name: state.me.name }
    },
  },

  'org.read': {
    id: 'org.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See your current team',
      dataDescription: 'Its name and your role in it.',
      tier: 'workspace',
    },
    limits: { perMinute: 10, perHour: 60, maxResponseBytes: 4 * 1024 },
    cacheTtlMs: 60_000,
    validate: noParams,
    run: async ctx => {
      const state = await ctx.source.getSessionState()
      if (!state.authenticated || !state.me) throw new CapabilityNotFoundError('no session')
      return {
        teamId: state.me.teamId,
        teamName: state.me.teamName,
        role: state.me.role,
      }
    },
  },

  'agents.read': {
    id: 'agents.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See the agents you have access to',
      dataDescription: 'Their names and which MCP servers they use.',
      tier: 'workspace',
    },
    limits: { perMinute: 10, perHour: 120, maxResponseBytes: 256 * 1024 },
    cacheTtlMs: 30_000,
    validate: noParams,
    run: async ctx => {
      const agents = await ctx.source.listMyAgents()
      return {
        agents: agents.map(agent => ({
          // `gfsSubject.id` is the stable grant-target id (`1st:<ns>/<name>`);
          // older servers omit it, so `name` is the fallback identity.
          id: agent.gfsSubject?.id ?? agent.name,
          name: agent.name,
          contextRef: agent.contextRef ?? null,
          provider: agent.provider ?? null,
          mcpServers: (agent.mcpServers ?? []).map(server => server.name),
        })),
      }
    },
  },

  'contexts.read': {
    id: 'contexts.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See the contexts you have access to',
      dataDescription: 'The names of the contexts available to you.',
      tier: 'workspace',
    },
    limits: { perMinute: 10, perHour: 120, maxResponseBytes: 64 * 1024 },
    cacheTtlMs: 30_000,
    validate: noParams,
    run: async ctx => {
      const catalog = await ctx.source.getAccessCatalog()
      const userIds = new Set(catalog.userContextIds ?? [])
      const seen = new Set<string>()
      const contexts: Array<{ id: string; scope: 'user' | 'team' }> = []
      for (const id of [...(catalog.userContextIds ?? []), ...(catalog.teamContextIds ?? [])]) {
        if (seen.has(id)) continue
        seen.add(id)
        contexts.push({ id, scope: userIds.has(id) ? 'user' : 'team' })
      }
      return { contexts }
    },
  },

  'mcp.read': {
    id: 'mcp.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See the MCP servers you have access to',
      dataDescription: 'Their names and which of your agents can call them.',
      tier: 'workspace',
    },
    limits: { perMinute: 10, perHour: 120, maxResponseBytes: 128 * 1024 },
    cacheTtlMs: 30_000,
    validate: noParams,
    run: async ctx => {
      const [result, catalog] = await Promise.all([
        ctx.source.listAccessibleMcpServers(),
        ctx.source.getAccessCatalog().catch(() => null),
      ])
      const byServer = new Map<string, string[]>()
      for (const [agent, servers] of Object.entries(catalog?.mcpServersByAgent ?? {})) {
        for (const server of servers ?? []) {
          byServer.set(server, [...(byServer.get(server) ?? []), agent])
        }
      }
      // Every `url` is dropped. A cluster-internal URL is infrastructure detail
      // the embed cannot even reach under `connect-src 'self'`, and shipping it
      // would turn a read capability into a lateral-movement hint (spec §6.5).
      return {
        servers: (result.servers ?? []).map(server => ({
          name: server.name,
          agents: byServer.get(server.name) ?? [],
        })),
      }
    },
  },

  'gfs.list': {
    id: 'gfs.list',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'See the shared files you have access to',
      dataDescription: 'Their names, folders, and sizes. It will not be able to open them.',
      tier: 'workspace',
    },
    limits: { perMinute: 30, perHour: 600, maxResponseBytes: 512 * 1024 },
    cacheTtlMs: 0,
    validate: raw => {
      const record = allowKeys(raw, ['drive', 'resourceId', 'cursor'])
      return {
        drive: optionalString(record.drive, 'drive', 64),
        resourceId: optionalString(record.resourceId, 'resourceId', 128),
        cursor: optionalString(record.cursor, 'cursor', 512),
      }
    },
    run: async (ctx, params) => {
      const drive = params.drive as string | undefined
      const resourceId = params.resourceId as string | undefined
      const cursor = params.cursor as string | undefined
      const page = resourceId
        ? await ctx.source.listGfsChildren(resourceId, drive, cursor)
        : await ctx.source.listAccessibleGfsResources(drive, cursor)
      return {
        items: (page.items ?? []).map(item => ({
          resourceId: item.resourceId,
          gfsUri: item.gfsUri,
          name: item.name,
          kind: item.kind,
          bytes: typeof item.bytes === 'number' ? item.bytes : null,
          version: item.version,
        })),
        nextCursor: page.nextCursor ?? null,
      }
    },
  },

  'gfs.read': {
    id: 'gfs.read',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'Open shared files you have access to',
      dataDescription: 'It will be able to read the contents of any file you can read.',
      tier: 'personal',
    },
    limits: { perMinute: 20, perHour: 300, maxResponseBytes: PLUGIN_GFS_IMAGE_MAX_BYTES * 2 },
    cacheTtlMs: 0,
    validate: raw => {
      const record = allowKeys(raw, ['uri', 'as'])
      const uri = requiredString(record.uri, 'uri', 2048)
      if (!uri.startsWith('gfs://')) throw new CapabilityInputError('uri must be a gfs:// link')
      const as = requiredString(record.as, 'as', 16)
      if (as !== 'text' && as !== 'dataUrl') {
        throw new CapabilityInputError("as must be 'text' or 'dataUrl'")
      }
      return { uri, as }
    },
    run: async (ctx, params) => {
      const uri = params.uri as string
      const as = params.as as 'text' | 'dataUrl'
      const { resource, bytes } = await ctx.source.downloadGfsUri(uri)
      const buffer = Buffer.from(bytes)
      const base = {
        gfsUri: resource.gfsUri,
        name: resource.name,
        bytes: buffer.byteLength,
      }

      if (as === 'dataUrl') {
        if (buffer.byteLength > PLUGIN_GFS_IMAGE_MAX_BYTES) {
          throw new CapabilityTooLargeError('image is larger than 10 MB')
        }
        // Trust the bytes, not the name. The declared MIME must be renderable
        // AND the magic bytes must agree (spec §6.6, T12).
        const detected = detectImageMime(buffer)
        if (!detected || !PLUGIN_GFS_IMAGE_MIME_TYPES.includes(detected as never)) {
          throw new CapabilityInputError(
            'file is not a renderable image (png, jpeg, gif, webp, avif)'
          )
        }
        return {
          ...base,
          as,
          mimeType: detected,
          dataUrl: `data:${detected};base64,${buffer.toString('base64')}`,
        }
      }

      if (buffer.byteLength > PLUGIN_GFS_TEXT_MAX_BYTES) {
        throw new CapabilityTooLargeError('file is larger than 2 MB')
      }
      const text = buffer.toString('utf8')
      // A lossy decode means the bytes were not UTF-8; returning replacement
      // characters would silently corrupt whatever the plugin does next.
      if (text.includes('\uFFFD')) {
        throw new CapabilityInputError('file is not valid UTF-8 text')
      }
      return { ...base, as, mimeType: 'text/plain', text }
    },
  },

  'theme.read': {
    id: 'theme.read',
    descriptorVersion: 1,
    // The ONE unscoped capability. Permitted only because the response says
    // nothing about the user, their org, or their data — only about the
    // Desktop's own presentation (spec §6.7). It is still audited, and still
    // listed on the plugin's Settings row.
    requiresConsent: false,
    consent: {
      title: 'See the app appearance',
      dataDescription: 'Whether the desktop app is in light or dark mode.',
      tier: 'ambient',
    },
    limits: { perMinute: 60, perHour: 600, maxResponseBytes: 1024 },
    cacheTtlMs: 0,
    validate: noParams,
    run: async ctx => ({ theme: ctx.source.getPluginTheme() }),
  },

  'notifications.notify': {
    id: 'notifications.notify',
    descriptorVersion: 1,
    requiresConsent: true,
    consent: {
      title: 'Send you notifications',
      dataDescription: 'It will be able to get your attention while you work elsewhere.',
      tier: 'workspace',
    },
    limits: { perMinute: 2, perHour: 20, maxResponseBytes: 1024 },
    cacheTtlMs: 0,
    validate: raw => {
      const record = allowKeys(raw, ['title', 'body', 'ref'])
      const title = plainText(requiredString(record.title, 'title', 120))
      if (!title) throw new CapabilityInputError('title is required')
      const body = optionalString(record.body, 'body', 400)
      const ref = optionalString(record.ref, 'ref', 256)
      return { title, body: body ? plainText(body) : undefined, ref }
    },
    run: async (ctx, params) =>
      ctx.source.showPluginNotification({
        pluginId: ctx.pluginId,
        pluginTitle: ctx.pluginTitle,
        title: params.title as string,
        body: params.body as string | undefined,
        ref: params.ref as string | undefined,
      }),
  },
}

export const CAPABILITY_IDS = Object.keys(CAPABILITIES)

export function getCapability(id: string): CapabilityDescriptor | null {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id) ? (CAPABILITIES[id] ?? null) : null
}

/** Prompt row ordering: most sensitive first, never buried at the bottom. */
const TIER_ORDER: Record<PluginCapabilityTier, number> = { personal: 0, workspace: 1, ambient: 2 }

export function sortCapabilitiesForPrompt(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const left = getCapability(a)
    const right = getCapability(b)
    const delta =
      TIER_ORDER[left?.consent.tier ?? 'workspace'] - TIER_ORDER[right?.consent.tier ?? 'workspace']
    return delta !== 0 ? delta : a.localeCompare(b)
  })
}
