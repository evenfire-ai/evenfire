/**
 * Electron wiring for the plugin SDK (spec §4).
 *
 * Everything Electron-shaped lives here so the broker, gate, store, and
 * capability catalog stay testable without an Electron runtime. This module is
 * the only one in the SDK that knows about BrowserWindow, Notification, or the
 * sandbox-ui driver.
 */
import { BrowserWindow, Notification, app } from 'electron'
import path from 'node:path'
import type { AppService } from './appService.js'
import { getActiveEnvKey } from './config.js'
import { type AuditEntry, PluginAuditLog } from './pluginAuditLog.js'
import { PluginConsentGate } from './pluginConsentGate.js'
import { type ConsentGrant, LocalConsentStore } from './pluginConsentStore.js'
import { PluginRateLimiter } from './pluginRateLimiter.js'
import { PluginSdkBroker } from './pluginSdkBroker.js'
import { CAPABILITIES, type PluginSdkDataSource, getCapability } from './pluginSdkCapabilities.js'
import {
  PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL,
  PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL,
  PLUGIN_SDK_EVENT_CHANNEL,
  type PluginGrantView,
  type PluginSdkEvent,
  type PluginTheme,
} from './pluginSdkProtocol.js'
import {
  type PinnedPluginSurface,
  allPinnedSurfaces,
  pinPluginSurface,
  resolvePluginSurface,
  surfacesForPlugin,
  unpinPluginSurface,
  unpinPluginSurfacesOfKind,
} from './pluginSurfaceRegistry.js'
import { PluginThemeStore } from './pluginThemeStore.js'

type RuntimeDeps = {
  service: AppService
  getMainWindow: () => BrowserWindow | null
  /** Overridable for tests. */
  userDataDir?: string
}

let runtime: PluginSdkRuntime | null = null

export class PluginSdkRuntime {
  readonly store: LocalConsentStore
  readonly audit: PluginAuditLog
  readonly limiter: PluginRateLimiter
  readonly gate: PluginConsentGate
  readonly broker: PluginSdkBroker
  readonly theme: PluginThemeStore

  /** pluginId → human title, learned at mount, used for prompts + notifications. */
  private readonly titles = new Map<string, string>()

  constructor(private readonly deps: RuntimeDeps) {
    const baseDir = deps.userDataDir ?? app.getPath('userData')
    this.store = new LocalConsentStore(path.join(baseDir, 'plugin-consent'))
    this.audit = new PluginAuditLog(path.join(baseDir, 'plugin-audit'))
    this.limiter = new PluginRateLimiter()
    this.theme = new PluginThemeStore(baseDir)

    this.gate = new PluginConsentGate({
      store: this.store,
      presentPrompt: request => this.sendToRenderer(PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL, request),
      cancelPrompt: promptId =>
        this.sendToRenderer(PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL, { promptId }),
      setSurfaceVisible: visible => this.deps.service.setSandboxUiVisible(visible),
      isWindowReady: () => {
        const win = this.deps.getMainWindow()
        if (!win || win.isDestroyed()) return false
        return win.isVisible() && !win.isMinimized() && win.isFocused()
      },
    })

    this.broker = new PluginSdkBroker({
      source: this.dataSource(),
      store: this.store,
      gate: this.gate,
      limiter: this.limiter,
      audit: this.audit,
      getEnvKey: () => getActiveEnvKey(),
      getUserId: () => this.currentUserId(),
    })

    this.theme.onChange(theme => {
      this.broadcastEvent({ type: 'theme.changed', theme })
    })
    void this.theme.load()
  }

  private currentUserId(): string | null {
    const metadata = this.deps.service.getTokenMetadata()
    if (!metadata.hasSession) return null
    return this.deps.service.getCachedUserId()
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /** Deliver an event to every mounted surface of one plugin. */
  private sendEventToPlugin(pluginId: string, event: PluginSdkEvent): void {
    for (const surface of surfacesForPlugin(pluginId)) {
      const contents = webContentsById(surface.webContentsId)
      if (!contents) continue
      contents.send(PLUGIN_SDK_EVENT_CHANNEL, event)
    }
  }

  /** Deliver an event to every mounted plugin surface. */
  private broadcastEvent(event: PluginSdkEvent): void {
    for (const surface of allPinnedSurfaces()) {
      const contents = webContentsById(surface.webContentsId)
      if (!contents) continue
      contents.send(PLUGIN_SDK_EVENT_CHANNEL, event)
    }
  }

  // ── Surface lifecycle ──────────────────────────────────────────────

  pinSandboxUiSurface(input: {
    pluginId: string
    pluginTitle: string
    webContentsId: number
    generation: number
  }): void {
    // The driver tears the previous embed down inside the next mount, so clear
    // the kind first — a stale pin would otherwise outlive its webContents.
    for (const dropped of unpinPluginSurfacesOfKind('sandbox-ui-embed')) {
      this.releasePlugin(dropped.pluginId)
    }
    this.titles.set(input.pluginId, input.pluginTitle)
    pinPluginSurface({ ...input, surface: 'sandbox-ui-embed' })
  }

  unpinSandboxUiSurface(webContentsId: number): void {
    const surface = resolvePluginSurface(webContentsId)
    unpinPluginSurface(webContentsId)
    if (surface) this.releasePlugin(surface.pluginId)
  }

  unpinAllSandboxUiSurfaces(): void {
    for (const dropped of unpinPluginSurfacesOfKind('sandbox-ui-embed')) {
      this.releasePlugin(dropped.pluginId)
    }
  }

  /** Per-mount state dies with the mount: denials, prompt budget, rate budget, cache. */
  private releasePlugin(pluginId: string): void {
    this.gate.resetPlugin(pluginId)
    this.limiter.reset(pluginId)
    this.broker.invalidateCache(pluginId)
  }

  // ── Session / theme signals ────────────────────────────────────────

  notifySessionChanged(authenticated: boolean): void {
    this.broker.invalidateCache()
    this.broadcastEvent({ type: 'session.changed', authenticated })
  }

  setTheme(theme: unknown): void {
    this.theme.set(theme)
  }

  // ── Settings surface (trusted renderer) ────────────────────────────

  async listGrants(): Promise<PluginGrantView[]> {
    const userId = this.currentUserId()
    if (!userId) return []
    const grants = await this.store.list(getActiveEnvKey(), userId)
    return grants.flatMap(grant => {
      const descriptor = getCapability(grant.capability)
      if (!descriptor) return []
      return [
        {
          pluginId: grant.pluginId,
          pluginTitle:
            this.titles.get(grant.pluginId) ?? grant.pluginId.split('/').pop() ?? grant.pluginId,
          capability: grant.capability,
          title: descriptor.consent.title,
          dataDescription: descriptor.consent.dataDescription,
          tier: descriptor.consent.tier,
          grantedAt: grant.grantedAt,
          lastUsedAt: grant.lastUsedAt,
        },
      ]
    })
  }

  async revokeGrant(pluginId: string, capability: string): Promise<void> {
    const userId = this.currentUserId()
    if (!userId) throw new Error('no active session')
    const envKey = getActiveEnvKey()
    await this.store.revoke({ envKey, userId, pluginId, capability })
    this.broker.invalidateCache(pluginId)
    await this.audit.append(envKey, {
      ts: new Date().toISOString(),
      userId,
      pluginId,
      capability,
      outcome: 'revoked',
      consent: 'user_revoked',
    })
    // Immediate, so a running plugin drops back to its unauthenticated
    // rendering instead of discovering the revocation on its next call.
    this.sendEventToPlugin(pluginId, { type: 'permission.changed', capability, granted: false })
  }

  async revokeAllForPlugin(pluginId: string): Promise<void> {
    const userId = this.currentUserId()
    if (!userId) throw new Error('no active session')
    const envKey = getActiveEnvKey()
    const existing = (await this.store.list(envKey, userId)).filter(
      grant => grant.pluginId === pluginId
    )
    await this.store.revokeAllForPlugin(envKey, userId, pluginId)
    this.broker.invalidateCache(pluginId)
    for (const grant of existing) {
      await this.audit.append(envKey, {
        ts: new Date().toISOString(),
        userId,
        pluginId,
        capability: grant.capability,
        outcome: 'revoked',
        consent: 'user_revoked',
      })
      this.sendEventToPlugin(pluginId, {
        type: 'permission.changed',
        capability: grant.capability,
        granted: false,
      })
    }
  }

  async readAudit(options?: { limit?: number; includeAmbient?: boolean }): Promise<AuditEntry[]> {
    const userId = this.currentUserId()
    if (!userId) return []
    const entries = await this.audit.read(getActiveEnvKey(), {
      limit: options?.limit ?? 200,
      userId,
    })
    if (options?.includeAmbient) return entries
    // `theme.read` fires constantly; including it by default would drown the
    // entries a user actually opened this view to see (spec §10.3).
    return entries.filter(entry => getCapability(entry.capability)?.consent.tier !== 'ambient')
  }

  async clearAudit(): Promise<void> {
    await this.audit.clear(getActiveEnvKey())
  }

  resolveConsentPrompt(promptId: string, allowed: string[]): boolean {
    return this.gate.resolvePrompt(promptId, allowed)
  }

  /** Prune grants for plugins the user can no longer reach (spec §10.5). */
  async pruneGrantsToPlugins(pluginIds: Set<string>): Promise<void> {
    const userId = this.currentUserId()
    if (!userId) return
    await this.store.pruneToPlugins(getActiveEnvKey(), userId, pluginIds)
  }

  // ── Data source ────────────────────────────────────────────────────

  private dataSource(): PluginSdkDataSource {
    const service = this.deps.service
    return {
      getSessionState: () => service.getSessionState(),
      listMyAgents: () => service.listMyAgents(),
      getAccessCatalog: () => service.getAccessCatalog(),
      listAccessibleMcpServers: () => service.listAccessibleMcpServers(),
      listAccessibleGfsResources: (drive, cursor) =>
        service.listAccessibleGfsResources(drive, cursor),
      listGfsChildren: (resourceId, drive, cursor) =>
        service.listGfsChildren(resourceId, drive, cursor),
      downloadGfsUri: uri => service.downloadGfsUri(uri),
      getPluginTheme: () => this.theme.get(),
      openGfsResource: input => this.openGfsResource(input.uri),
      showPluginNotification: input => this.showNotification(input),
    }
  }

  /**
   * Resolve a `gfs://` link with the USER's session and hand it to the trusted
   * renderer to display. The plugin gets back only whether it opened — never the
   * name, size, or bytes. The internal `reason` returned here is for the audit
   * line and the navigation path; the `gfs.open` capability drops it before the
   * plugin sees it, so absent and unauthorized both read as `opened: false`.
   * A resolvable link IS still distinguishable from a non-resolvable one, so this
   * is a narrow accessibility signal — bounded by the 6/min budget, unguessable
   * resource ids, a live user session, and a viewer that paints over the plugin
   * on every hit. Reads over that bound: mark the capability `requiresConsent`.
   *
   * Reached two ways, both landing here so they share the rate budget and the
   * audit line: `clerum.gfs.open(uri)` through the broker, and a plain
   * `<a href="gfs://…">` intercepted by the embed's navigation policy.
   */
  async openGfsResource(uri: string): Promise<{ opened: boolean; reason?: string }> {
    const link = String(uri || '').trim()
    if (!link.startsWith('gfs://')) return { opened: false, reason: 'invalid_uri' }
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed()) return { opened: false, reason: 'unavailable' }

    let resource
    try {
      resource = await this.deps.service.resolveGfsUri(link)
    } catch (err) {
      console.warn('[PluginSDK] gfs.open resolve failed:', err)
      return { opened: false, reason: 'not_found' }
    }

    this.sendToRenderer('pluginSdk:openGfsResource', {
      gfsUri: resource.gfsUri ?? link,
      name: resource.name,
      kind: resource.kind,
      bytes: typeof resource.bytes === 'number' ? resource.bytes : null,
    })
    return { opened: true }
  }

  /**
   * Entry point for the `<a href="gfs://…">` path. The broker owns rate limiting
   * and auditing for `clerum.gfs.open`, so a link click has to route through it
   * too — otherwise a plugin could dodge the budget by rendering anchors.
   */
  async openGfsResourceFromNavigation(webContentsId: number, uri: string): Promise<void> {
    const result = await this.broker.request(webContentsId, {
      v: 1,
      capability: 'gfs.open',
      params: { uri },
    })
    if (!result.ok) {
      console.warn('[PluginSDK] gfs link open refused:', result.error.code)
    }
  }

  private async showNotification(input: {
    pluginId: string
    pluginTitle: string
    title: string
    body?: string
    ref?: string
  }): Promise<{ delivered: boolean; reason?: 'suppressed' | 'unsupported' }> {
    // Suppressed when the user is already looking at this plugin: interrupting
    // someone about the thing on their screen is noise, not attention.
    if (this.isPluginInForeground(input.pluginId)) {
      return { delivered: false, reason: 'suppressed' }
    }
    if (!Notification.isSupported()) return { delivered: false, reason: 'unsupported' }

    // Mandatory attribution — a plugin must never be able to look like Evenfire
    // itself or like another plugin (spec §6.8, T13).
    const notification = new Notification({
      title: `${input.pluginTitle} — ${input.title}`,
      ...(input.body ? { body: input.body } : {}),
    })
    notification.on('click', () => {
      const win = this.deps.getMainWindow()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      this.sendToRenderer('pluginSdk:notificationClicked', {
        pluginId: input.pluginId,
        ref: input.ref ?? null,
      })
      this.sendEventToPlugin(input.pluginId, {
        type: 'notification.clicked',
        ref: input.ref ?? null,
      })
    })
    notification.show()
    return { delivered: true }
  }

  private isPluginInForeground(pluginId: string): boolean {
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) {
      return false
    }
    return surfacesForPlugin(pluginId).some(surface => surface.surface === 'sandbox-ui-embed')
  }
}

function webContentsById(id: number): Electron.WebContents | null {
  for (const win of BrowserWindow.getAllWindows()) {
    for (const view of win.contentView?.children ?? []) {
      const contents = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (contents && !contents.isDestroyed() && contents.id === id) return contents
    }
    if (!win.isDestroyed() && win.webContents.id === id) return win.webContents
  }
  return null
}

export function initPluginSdkRuntime(deps: RuntimeDeps): PluginSdkRuntime {
  runtime = new PluginSdkRuntime(deps)
  return runtime
}

export function getPluginSdkRuntime(): PluginSdkRuntime {
  if (!runtime) throw new Error('plugin SDK runtime not initialized')
  return runtime
}

export function tryGetPluginSdkRuntime(): PluginSdkRuntime | null {
  return runtime
}

/** ONLY for tests. */
export function _resetPluginSdkRuntimeForTests(): void {
  runtime = null
}

export type { AuditEntry, ConsentGrant }
export { CAPABILITIES }
export type { PinnedPluginSurface, PluginTheme }
