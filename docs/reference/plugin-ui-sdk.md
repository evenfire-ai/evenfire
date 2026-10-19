# Plugin UI SDK (`window.clerum`)

A plugin can ship a web app that the Desktop App shows under **Apps**. Inside
that app, the Desktop App exposes a small JavaScript API on `window.clerum`. The
app uses it to ask the user for access to their information (who they are,
their team, agents, contexts, MCP servers, shared files), to follow the app's
light or dark theme, and to send desktop notifications.

There is no npm package for this API. Your app's JavaScript calls
`window.clerum` directly, and the Desktop App injects it.

SDK version `1.0.0`, wire protocol `1`.

## Where it is available

The API on this page is injected only into a **sandbox UI embedded in the
Desktop App**: the web app a recipe declares in `spec.ui`. It is not available
in the Control UI, in Profile UI, in a normal browser tab, or in a recipe's
backend workloads. The Desktop App's own interface has a separate, trusted
`window.clerum` bridge with a different shape (see
[Desktop App § Electron security posture](../surfaces/desktop-app.md#electron-security-posture));
plugins cannot reach it.

A recipe declares one sandbox UI by pointing `spec.ui.workloadRef` at a
`type: deployment` workload and naming its HTTP `port`. See
[WorkflowRecipe § Sandbox UI (`spec.ui`)](../crds/workflowrecipe.md#316-sandbox-ui-specui)
for the fields and validation rules, and the
[recipe authoring guide](../agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md#6-sandbox-ui-specui)
for build and image requirements.

The Desktop App loads the UI through `rpc-proxy` into its own
`WebContentsView` and attaches the SDK as that view's preload script. Each
mounted UI is registered with the Desktop App under the plugin id
`<recipeNamespace>/<recipeName>`. The plugin never says who it is; the Desktop
App derives the id from the view that sent the call.

Always feature-detect, so the same UI still works outside the Desktop App:

```js
const sdk = window.clerum && window.clerum.sdk
if (!sdk) {
  // Not running inside the Desktop App. Render without the SDK.
}
```

## Response shape

Every SDK method except `on` and `onOauthCompleted` returns a promise that
resolves to one of two shapes. It does not reject for a refused call.

```ts
type PluginSdkResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }
```

`message` is safe to show to the user. It never carries upstream error bodies.
`retryable` is `true` when the same call may succeed later without the user
doing anything (for example, after a rate limit).

## API surface

### `clerum.sdk`

| Member                        | Returns                                              | Notes                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.version`                 | `'1.0.0'`                                            | String constant.                                                                                                                                                    |
| `sdk.protocol`                | `1`                                                  | Number constant.                                                                                                                                                    |
| `sdk.capabilities()`          | `{ capabilities: string[], version: string }`        | The capability ids this Desktop build implements. Use it to degrade gracefully on an older Desktop App.                                                             |
| `sdk.requestPermissions(ids)` | `{ granted: Record<string, boolean>, all: boolean }` | Asks for 1 to 8 capabilities in **one** consent prompt. Shows a prompt only for ids that are not already granted. A partial grant is a normal result, not an error. |
| `sdk.permissions(ids?)`       | `{ granted: Record<string, boolean> }`               | Reads grant state **without** prompting. With no argument it reports every capability. Up to 8 ids when you pass a list.                                            |
| `sdk.on(callback)`            | an unsubscribe function                              | Receives [events](#events).                                                                                                                                         |

`requestPermissions` and `permissions` return `invalid_request` for an empty
list (for `requestPermissions`), more than 8 ids, a duplicate id, a non-string
entry, or an unknown capability id.

### Capability methods

Each method below sends one capability call. If the capability needs consent
and the user has not granted it yet, the call itself opens a one-row consent
prompt. Call `requestPermissions` first so the user sees one prompt for
everything your app needs.

| Method                                                | Capability id          | Consent |
| ----------------------------------------------------- | ---------------------- | ------- |
| `clerum.identity.get()`                               | `identity.read`        | Yes     |
| `clerum.org.get()`                                    | `org.read`             | Yes     |
| `clerum.agents.list()`                                | `agents.read`          | Yes     |
| `clerum.contexts.list()`                              | `contexts.read`        | Yes     |
| `clerum.mcp.list()`                                   | `mcp.read`             | Yes     |
| `clerum.gfs.list({ drive?, resourceId?, cursor? })`   | `gfs.list`             | Yes     |
| `clerum.gfs.read({ uri, as })`                        | `gfs.read`             | Yes     |
| `clerum.gfs.open(uri)`                                | `gfs.open`             | No      |
| `clerum.theme.get()`                                  | `theme.read`           | No      |
| `clerum.notifications.notify({ title, body?, ref? })` | `notifications.notify` | Yes     |

### Legacy methods

These two predate the SDK and are kept unchanged.

| Method                              | What it does                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clerum.requestSessionRefresh()`    | Asks the Desktop App to mint a fresh embed session cookie, for when a fetch or SSE stream gets a `401` between scheduled refreshes. Limited to one refresh per 30 seconds per view; a refused call rejects the promise.                           |
| `clerum.onOauthCompleted(callback)` | Calls `callback({ oauthClientId, provider })` when an OAuth connect flow started from this UI finishes. Returns an unsubscribe function. See the [OAuth embed lifecycle](../agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md#73-embed-lifecycle-canonical). |

## Capabilities

Every capability goes through the user's own Desktop session, so Control API
authorizes it exactly as it would for the Desktop App's own pages. Consent is
an extra gate on top of what the user can already see, never a way around it.
Each capability returns a reduced view of the data, listed below.

The **Prompt text** column is what the user reads in the consent prompt and in
Settings for capabilities that need consent. Your app cannot change it.
`gfs.open` and `theme.read` never prompt and never appear as grants.

| Capability             | Returns (`data`)                                                                                                                                                                        | Consent | Prompt text                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `identity.read`        | `{ userId, email, name }`. No profile picture URL.                                                                                                                                      | Yes     | See who you are. _Your name, email address, and user id._                                                             |
| `org.read`             | `{ teamId, teamName, role }` for the user's current team.                                                                                                                               | Yes     | See your current team. _Its name and your role in it._                                                                |
| `agents.read`          | `{ agents: [{ id, name, contextRef, provider, mcpServers }] }`. `mcpServers` is a list of server names. `contextRef` and `provider` can be `null`.                                      | Yes     | See the agents you have access to. _Their names and which MCP servers they use._                                      |
| `contexts.read`        | `{ contexts: [{ id, scope }] }`, where `scope` is `'user'` or `'team'`.                                                                                                                 | Yes     | See the contexts you have access to. _The names of the contexts available to you._                                    |
| `mcp.read`             | `{ servers: [{ name, agents }] }`. `agents` lists the user's agents that can call that server. Server URLs are removed.                                                                 | Yes     | See the MCP servers you have access to. _Their names and which of your agents can call them._                         |
| `gfs.list`             | `{ items: [{ resourceId, gfsUri, name, kind, bytes, version }], nextCursor }`. Without `resourceId`, lists the shared files the user can access; with it, lists that folder's children. | Yes     | See the shared files you have access to. _Their names, folders, and sizes. It will not be able to open them._         |
| `gfs.read`             | `as: 'text'`: `{ gfsUri, name, bytes, as, mimeType: 'text/plain', text }`. `as: 'dataUrl'`: `{ gfsUri, name, bytes, as, mimeType, dataUrl }`.                                           | Yes     | Open shared files you have access to. _It will be able to read the contents of any file you can read._                |
| `gfs.open`             | `{ opened: boolean }`. Opens the file in the Desktop App's own viewer, over the plugin. The plugin never sees the file.                                                                 | No      | Open a shared file in the Evenfire viewer. _Shows you a file you already have access to. The plugin does not see it._ |
| `theme.read`           | `{ theme: 'light' \| 'dark' }`. Default `'dark'`.                                                                                                                                       | No      | See the app appearance. _Whether the desktop app is in light or dark mode._                                           |
| `notifications.notify` | `{ delivered: boolean, reason?: 'suppressed' \| 'unsupported' }`.                                                                                                                       | Yes     | Send you notifications. _It will be able to get your attention while you work elsewhere._                             |

### Parameters and limits per capability

- **No-parameter capabilities** (`identity.read`, `org.read`, `agents.read`,
  `contexts.read`, `mcp.read`, `theme.read`) return `invalid_request` if you
  pass any parameter.
- **`gfs.list`** accepts only `drive` (max 64 characters), `resourceId` (max 128) and `cursor` (max 512). Pass the previous `nextCursor` to get the next
  page.
- **`gfs.read`** requires `uri` (a `gfs://` link, max 2048 characters) and `as`
  (`'text'` or `'dataUrl'`).
  - `as: 'text'` refuses files over 2 MB (`payload_too_large`) and files that
    are not valid UTF-8 (`invalid_request`).
  - `as: 'dataUrl'` is for images only. It refuses files over 10 MB and checks
    the file's actual bytes, not its name: only PNG, JPEG, GIF, WebP and AVIF
    pass. SVG is refused on purpose; ship vector art in your own bundle.
- **`gfs.open`** requires a `gfs://` uri. A failure returns `opened: false`
  with no reason, so a missing file and a file the user cannot access look the
  same. An `<a href="gfs://…">` link in your UI does the same thing as
  `gfs.open` and shares its rate limit.
- **`notifications.notify`** requires `title` (max 120 characters); `body` (max 400) and `ref` (max 256) are optional. Control characters are replaced with
  spaces. The Desktop App always prefixes the title with your app's title
  (`<app title> — <title>`), so a notification cannot pose as Evenfire or as
  another plugin. It is not shown (`delivered: false, reason: 'suppressed'`)
  when the user is already looking at your app. When the user clicks it, the
  Desktop App comes to the front and your app gets a `notification.clicked`
  event carrying your `ref`.

## Events

`clerum.sdk.on(callback)` delivers these events to every mounted surface of
your plugin:

| Event                  | Payload                                | When                                                                            |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `theme.changed`        | `{ type, theme: 'light' \| 'dark' }`   | The Desktop App's theme changes.                                                |
| `permission.changed`   | `{ type, capability, granted: false }` | The user revokes a grant in Settings. Sent immediately, while your app is open. |
| `session.changed`      | `{ type, authenticated: boolean }`     | The user logs in or out of the Desktop App.                                     |
| `notification.clicked` | `{ type, ref: string \| null }`        | The user clicks a notification your app sent.                                   |

## Consent

### The prompt

The consent prompt is drawn by the Desktop App, not by your app. While it is
open, the Desktop App hides your app's view, so a plugin cannot fake the prompt
or draw over it.

- The heading is **`<app title>` wants access to your information**. Every
  other word comes from the Desktop App's own capability list.
- Rows are sorted most sensitive first (personal data, then workspace data) and
  start checked. The user unchecks rows to grant only part of a request.
- **Allow** grants the checked rows. **Deny** or **Escape** denies all rows.
- A prompt nobody answers within 120 seconds counts as a denial.
- Only one prompt is shown at a time, across all plugins. The prompt waits until
  a Desktop window is visible and focused.

### Prompt limits

- A plugin can show at most **3 prompts per mount**. After that, every
  ungranted capability is denied until the user reopens the app.
- There are at least 10 seconds between two prompts from the same plugin.
- From the second prompt on, the prompt tells the user how many times this
  plugin has asked this session.
- A **denial** lasts for the current mount only: the plugin is not asked again
  for that capability until the user closes and reopens the app. A mis-click is
  not a permanent lockout.
- A **grant** lasts until the user revokes it.

### Where grants are stored

Grants are stored on the user's machine, in
`<userData>/plugin-consent/` (one JSON file per environment, file mode `0600`).
They are scoped to the environment (cluster), the user, the plugin id and the
capability. A grant on one cluster or for one user never applies to another.
Grants do not sync between devices.

If a capability's payload widens in a later Desktop release, the old grant no
longer covers it and the user is asked again.

### Revoking

Users manage grants in **Settings → Plugin permissions**:

- The **Permissions** tab lists each plugin, the permissions it holds and when
  they were last used. **Revoke all** removes every grant for a plugin. Expand
  a plugin to see each permission with the same sentence the prompt showed, and
  **Revoke** it on its own.
- The **Activity** tab lists what plugins requested and the result (Shared,
  Granted, Denied, Revoked, Revoked mid-request, Rate limited, Error).
  **Clear activity log** empties it. `theme.read` and `gfs.open` calls are left
  out of this view.

Revoking takes effect immediately, even while the plugin is open: the plugin
gets a `permission.changed` event, cached results for it are dropped, and a call
already in flight returns `permission_revoked` instead of data.

### Activity log

The Desktop App keeps a local activity log in `<userData>/plugin-audit/` (one
JSONL file per environment, mode `0600`, rotated at 5 MB or 90 days). It records
the **shape** of what a plugin received (field names, item counts, byte sizes),
never the content.

## Errors

| Code                     | Retryable | Meaning                                                                                                    |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| `unsupported_capability` | No        | Unknown capability id.                                                                                     |
| `unsupported_version`    | No        | The request named a protocol version other than `1`.                                                       |
| `invalid_request`        | No        | Bad or unexpected parameters, a bad capability list, a non-UTF-8 text file, or a non-image `dataUrl` read. |
| `unauthenticated`        | Yes       | The user is not logged in to the Desktop App.                                                              |
| `permission_denied`      | Yes       | The user has not granted this capability (denied, prompt dismissed, timed out, or prompt budget spent).    |
| `permission_revoked`     | Yes       | The user revoked the grant while the call was running.                                                     |
| `rate_limited`           | Yes       | Over a rate limit. The message says how many milliseconds to wait.                                         |
| `not_found`              | No        | Not found. Also returned when the user cannot access the item, so the SDK never reveals what exists.       |
| `payload_too_large`      | No        | The file or result is over the size limit.                                                                 |
| `unavailable`            | Yes       | The Desktop App could not complete the request (for example, an upstream failure).                         |
| `internal`               | No        | The calling view is not a registered plugin surface.                                                       |

## Rate limits

The Desktop App enforces these limits per plugin, in memory. Budgets refill
continuously rather than resetting every minute, and they reset when the user
closes and reopens the app. A call over a limit returns `rate_limited`.

| Capability                       | Per minute | Per hour | Max response size |
| -------------------------------- | ---------- | -------- | ----------------- |
| `identity.read`                  | 10         | 60       | 4 KB              |
| `org.read`                       | 10         | 60       | 4 KB              |
| `agents.read`                    | 10         | 120      | 256 KB            |
| `contexts.read`                  | 10         | 120      | 64 KB             |
| `mcp.read`                       | 10         | 120      | 128 KB            |
| `gfs.list`                       | 30         | 600      | 512 KB            |
| `gfs.read`                       | 20         | 300      | 20 MB             |
| `gfs.open`                       | 6          | 60       | 1 KB              |
| `theme.read`                     | 60         | 600      | 1 KB              |
| `notifications.notify`           | 2          | 20       | 1 KB              |
| **All capabilities, per plugin** | **120**    | **2400** | —                 |

A result larger than the capability's maximum returns `payload_too_large`.

Some results are cached for a short time, so repeated calls return the same
data: `identity.read` and `org.read` for 60 seconds, `agents.read`,
`contexts.read` and `mcp.read` for 30 seconds. The cache is cleared on logout,
login and revocation. Cached calls still count against the rate limit.

## Security model

What a plugin UI **cannot** do:

- **Claim another identity.** The plugin id comes from the view that sent the
  call, never from the request.
- **Answer its own consent prompt.** The prompt runs in the Desktop App's
  trusted window, the plugin's view is hidden while it is open, and the answer
  channel accepts only the trusted window and a one-time prompt id.
- **See more than the user can.** Every call uses the user's own session and
  Control API permissions.
- **See infrastructure detail.** MCP server URLs and profile picture URLs are
  removed, and errors never include upstream response bodies.
- **Read a file through `gfs.open`**, or learn why it failed.
- **Reach other origins.** The embed's Content Security Policy is
  `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:`
  (plus related directives). Inline `<script>` blocks do not run; load your
  JavaScript from a file served by your UI. Fetches go only to your UI's own
  origin through `rpc-proxy`. A recipe's server-side workload reaches external
  services through `spec.ui.egress`.
- **Navigate away or open windows.** Navigation is pinned to the UI's own path.
  `http(s)` links and `window.open` open in the user's default browser. Other
  schemes are dropped, except `clerum://oauth?clientId=…` (starts an OAuth
  connect) and `gfs://…` (behaves like `gfs.open`).
- **Use device features or download files.** Camera, microphone, location,
  web notifications, USB, serial, HID, Bluetooth and MIDI are all denied; only
  fullscreen is allowed. Downloads are blocked.
- **Use Node.js or Electron APIs.** The view runs with `sandbox: true`,
  `contextIsolation: true` and `nodeIntegration: false`. `window.clerum` is a
  frozen object.

The SDK is meant to reduce what a plugin can see, not to make an untrusted
plugin safe. Only install plugins from publishers you trust.

## Example

Serve this as a file (for example `app.js`) from your UI workload and load it
with `<script src="app.js"></script>`; the CSP blocks inline scripts.

```js
const clerum = window.clerum

async function start() {
  if (!clerum || !clerum.sdk) {
    renderWithoutSdk()
    return
  }

  // Follow the Desktop theme. No consent needed.
  const theme = await clerum.theme.get()
  if (theme.ok) document.documentElement.dataset.theme = theme.data.theme

  // Check first, so a returning user sees no prompt.
  const wanted = ['identity.read', 'agents.read']
  const state = await clerum.sdk.permissions(wanted)
  const missing = state.ok ? wanted.filter(id => !state.data.granted[id]) : wanted
  if (missing.length > 0) {
    await clerum.sdk.requestPermissions(missing) // one prompt for both
  }

  const me = await clerum.identity.get()
  if (me.ok) {
    renderGreeting(me.data.name)
  } else if (me.error.code === 'permission_denied') {
    renderSignedOutView() // a partial grant is normal; keep working
  }

  const agents = await clerum.agents.list()
  if (agents.ok) renderAgents(agents.data.agents)

  clerum.sdk.on(event => {
    if (event.type === 'theme.changed') {
      document.documentElement.dataset.theme = event.theme
    }
    if (event.type === 'permission.changed' && !event.granted) {
      renderSignedOutView()
    }
  })
}

start()
```

## Plugin UI SDK vs. Plugin Workload SDK

This page covers the **browser-side** API that a plugin's UI uses inside the
Desktop App. The **Plugin Workload SDK** is a different, server-side feature: a
recipe's backend workloads declare `spec.pluginWorkloadSdk` to use
`promptBridge` (LLM calls) and `clientNotifications` through Control API, with
its own grants and its own platform rate limits. See
[WorkflowRecipe § Plugin Workload SDK](../crds/workflowrecipe.md#319-plugin-workload-sdk-specpluginworkloadsdk)
and the [Plugin Workload SDK upgrade runbook](../deploy/plugin-workload-sdk-upgrade.md).
Custom workflow coordinators are built with a third package,
[`@clerum/workflow-sdk`](../../packages/workflow-sdk/README.md) (with
`packages/workflow-runtime-core`). The rate limits on this page are enforced by
the Desktop App and are separate from the Control API limits in that runbook.

## Related

- [Use the Desktop App § Apps and Plugins](../how-to/use-the-desktop-app.md#apps-and-plugins)
- [Desktop App surface](../surfaces/desktop-app.md)
- [Connect an OAuth connector](../how-to/connect-oauth-connector.md)
- [Publish a plugin to the registry](../how-to/publish-plugin-to-registry.md)
