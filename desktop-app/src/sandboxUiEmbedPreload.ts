import { contextBridge, ipcRenderer } from 'electron'
// TYPE-ONLY import: erased at compile time, so it never becomes a `require`.
import type { PluginSdkEvent, PluginSdkResponse } from './pluginSdkProtocol.js'

/**
 * Channel names are duplicated here on purpose.
 *
 * This preload runs with `sandbox: true`, where Electron's `require` is a
 * polyfill limited to `electron` and a couple of Node builtins — a relative
 * `require('./pluginSdkProtocol.js')` throws at runtime. Until the preload gets
 * its own bundling step, the values are inlined and
 * `__tests__/sandboxUiEmbedPreload.contract.test.ts` asserts they still match
 * `pluginSdkProtocol.ts` so the two cannot drift apart silently.
 */
const PLUGIN_SDK_VERSION = '1.0.0'
const PLUGIN_SDK_PROTOCOL = 1
const PLUGIN_SDK_REQUEST_CHANNEL = 'clerum:plugin-sdk:request'
const PLUGIN_SDK_PERMISSIONS_CHANNEL = 'clerum:plugin-sdk:request-permissions'
const PLUGIN_SDK_PERMISSION_STATE_CHANNEL = 'clerum:plugin-sdk:permissions'
const PLUGIN_SDK_CAPABILITIES_CHANNEL = 'clerum:plugin-sdk:capabilities'
const PLUGIN_SDK_EVENT_CHANNEL = 'clerum:plugin-sdk:event'

/**
 * Preload script attached to every sandbox-ui `WebContentsView`. Exposes the
 * plugin-facing surface to recipe JS:
 *
 *   Legacy (unchanged, and deliberately so — every shipped recipe uses these):
 *     `clerum.requestSessionRefresh()` — recover from a stale session cookie
 *        when an SSE/fetch hits 401 between scheduled refreshes.
 *     `clerum.onOauthCompleted(cb)` — OAuth completion envelope, on its own
 *        legacy channel.
 *
 *   Plugin UI SDK (spec `docs/features/plugin-ui-sdk-1.md` §7):
 *     `clerum.sdk.*`           — version, capability list, batched consent,
 *                                grant state, events.
 *     `clerum.identity/org/agents/contexts/mcp/gfs/theme/notifications`
 *                              — one thin wrapper per capability.
 *
 * Everything here is a dumb pipe. No validation, no caching, no policy: this
 * code runs in a world the plugin's own JS can reach, so anything enforced on
 * this side is advisory. The real gating (caller pinning, consent, rate limits,
 * response minimization) is entirely main-side in `pluginSdkBroker.ts`.
 */
type SandboxUiOauthCompletedPayload = {
  oauthClientId: string
  provider: string
}

function invoke<T>(channel: string, payload?: unknown): Promise<PluginSdkResponse<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<PluginSdkResponse<T>>
}

function capability<T>(id: string, params?: unknown): Promise<PluginSdkResponse<T>> {
  return invoke<T>(PLUGIN_SDK_REQUEST_CHANNEL, {
    v: PLUGIN_SDK_PROTOCOL,
    capability: id,
    ...(params === undefined ? {} : { params }),
  })
}

contextBridge.exposeInMainWorld(
  'clerum',
  Object.freeze({
    requestSessionRefresh: (): Promise<void> =>
      ipcRenderer.invoke('clerum:sandbox-ui:request-refresh'),
    onOauthCompleted: (
      callback: (payload: SandboxUiOauthCompletedPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: SandboxUiOauthCompletedPayload
      ): void => {
        callback(payload)
      }
      ipcRenderer.on('clerum:sandbox-ui:oauth-completed', listener)
      return () => {
        ipcRenderer.off('clerum:sandbox-ui:oauth-completed', listener)
      }
    },

    sdk: Object.freeze({
      version: PLUGIN_SDK_VERSION,
      protocol: PLUGIN_SDK_PROTOCOL,
      /** Capability ids this host build implements — lets a plugin degrade
       *  gracefully on an older Desktop instead of hard-failing. */
      capabilities: () => invoke(PLUGIN_SDK_CAPABILITIES_CHANNEL),
      /** Ask for several capabilities in ONE modal. The intended entry point. */
      requestPermissions: (capabilities: string[]) =>
        invoke(PLUGIN_SDK_PERMISSIONS_CHANNEL, { v: PLUGIN_SDK_PROTOCOL, capabilities }),
      /** Grant state without prompting, so a returning user sees no modal. */
      permissions: (capabilities?: string[]) =>
        invoke(PLUGIN_SDK_PERMISSION_STATE_CHANNEL, capabilities ?? null),
      on: (callback: (event: PluginSdkEvent) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: PluginSdkEvent): void => {
          callback(payload)
        }
        ipcRenderer.on(PLUGIN_SDK_EVENT_CHANNEL, listener)
        return () => {
          ipcRenderer.off(PLUGIN_SDK_EVENT_CHANNEL, listener)
        }
      },
    }),

    identity: Object.freeze({ get: () => capability('identity.read') }),
    org: Object.freeze({ get: () => capability('org.read') }),
    agents: Object.freeze({ list: () => capability('agents.read') }),
    contexts: Object.freeze({ list: () => capability('contexts.read') }),
    mcp: Object.freeze({ list: () => capability('mcp.read') }),
    gfs: Object.freeze({
      list: (params?: { drive?: string; resourceId?: string; cursor?: string }) =>
        capability('gfs.list', params ?? {}),
      read: (params: { uri: string; as: 'text' | 'dataUrl' }) => capability('gfs.read', params),
      /** Show a shared file in the Desktop's own viewer. Same effect as the
       *  user clicking an `<a href="gfs://…">` the plugin rendered. */
      open: (uri: string) => capability('gfs.open', { uri }),
    }),
    theme: Object.freeze({ get: () => capability('theme.read') }),
    notifications: Object.freeze({
      notify: (params: { title: string; body?: string; ref?: string }) =>
        capability('notifications.notify', params),
    }),
  })
)
