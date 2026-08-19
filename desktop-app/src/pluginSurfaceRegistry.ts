/**
 * Which plugin is on the other end of an SDK request (spec §8.1).
 *
 * The plugin never identifies itself. Main derives its identity from the
 * sender's `webContents.id`, pinned when the surface mounts and unpinned when
 * it tears down. This generalizes the pinning map already proven for the
 * session-refresh IPC (`sandboxUiSessionRefresh.ts`) so more than one kind of
 * plugin surface can use it — today the sandbox-ui embed, tomorrow the Side
 * Window (spec §14).
 *
 * Why identity cannot be self-asserted: the embed loads from the rpc-proxy
 * origin, so `assertTrustedSender` (which requires file:// or the dev URL)
 * would reject every SDK call. The pinning map IS the trust check for these
 * channels. A sender absent from the map is a bug or an attack; either way it
 * gets nothing.
 */

export type PluginSurfaceKind = 'sandbox-ui-embed' | 'side-window'

export type PinnedPluginSurface = {
  /** `<recipeNs>/<recipeName>` — the consent + audit key. */
  pluginId: string
  /** Human title from the installed recipe, for prompt copy. Never plugin-supplied. */
  pluginTitle: string
  surface: PluginSurfaceKind
  webContentsId: number
  /**
   * Mount generation. The driver bumps its own counter on every mount; a
   * request tagged with a superseded generation is dropped so a slow call from
   * the previous embed cannot land against the new one's grants.
   */
  generation: number
}

const byWebContentsId = new Map<number, PinnedPluginSurface>()

export function pinPluginSurface(surface: PinnedPluginSurface): void {
  byWebContentsId.set(surface.webContentsId, surface)
}

export function unpinPluginSurface(webContentsId: number): void {
  byWebContentsId.delete(webContentsId)
}

/**
 * Drop every pin of one kind and report what was dropped.
 *
 * The sandbox-ui embed is one-at-a-time and its driver tears the previous view
 * down *inside* the next mount, so the outgoing surface never gets an unpin of
 * its own. Clearing the kind before pinning the newcomer is what stops a dead
 * webContents id from lingering in the map (and, after id reuse, from
 * resolving to the wrong plugin).
 */
export function unpinPluginSurfacesOfKind(kind: PluginSurfaceKind): PinnedPluginSurface[] {
  const dropped: PinnedPluginSurface[] = []
  for (const [id, surface] of [...byWebContentsId.entries()]) {
    if (surface.surface !== kind) continue
    dropped.push(surface)
    byWebContentsId.delete(id)
  }
  return dropped
}

/**
 * Resolve a sender to its plugin. Returns null for an unpinned sender — the
 * caller MUST treat that as a hard rejection, never as "unknown plugin".
 */
export function resolvePluginSurface(webContentsId: number): PinnedPluginSurface | null {
  return byWebContentsId.get(webContentsId) ?? null
}

/** Every surface currently mounted for a plugin (Side Window + embed). */
export function surfacesForPlugin(pluginId: string): PinnedPluginSurface[] {
  return [...byWebContentsId.values()].filter(s => s.pluginId === pluginId)
}

/** Every pinned surface, for events that go to all plugins (theme, session). */
export function allPinnedSurfaces(): PinnedPluginSurface[] {
  return [...byWebContentsId.values()]
}

export function pinnedSurfaceCount(): number {
  return byWebContentsId.size
}

/** ONLY for tests. */
export function _resetPluginSurfacesForTests(): void {
  byWebContentsId.clear()
}
