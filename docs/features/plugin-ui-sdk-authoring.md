# Plugin UI SDK — authoring guide

How to change a plugin (a `WorkflowRecipe` with `spec.ui`) so its embedded web
UI can read the user's context from the Evenfire Desktop App: their identity,
team, agents, contexts, MCP servers, shared files, the app theme, and a way to
get their attention.

This is the **plugin author's** guide. The design and threat model live in
[`plugin-ui-sdk-1.md`](./plugin-ui-sdk-1.md); read that if you want to know why
something behaves the way it does. Section references below (§) point at it.

---

## 1. TL;DR

Nothing in your recipe YAML changes. The SDK is injected into your embed as
`window.clerum.*`, deny-by-default, and the user approves what you ask for.

```js
// One modal for everything your plugin needs, only for what is still missing.
const NEED = ['identity.read', 'org.read', 'agents.read', 'gfs.list']

const state = await window.clerum.sdk.permissions(NEED)
const missing = NEED.filter(id => !state.data.granted[id])
if (missing.length) {
  const res = await window.clerum.sdk.requestPermissions(missing)
  if (!res.ok || !res.data.all) return renderPartial(res.data?.granted)
}

const me = await window.clerum.identity.get()
if (me.ok) greet(me.data.name ?? me.data.email)
```

**Checklist for an existing plugin:**

- [ ] Feature-detect: `window.clerum?.sdk` may be absent on an older Desktop.
- [ ] Call `sdk.permissions()` on boot; only `sdk.requestPermissions()` for the gap.
- [ ] Ask for everything you need in ONE batch (§5).
- [ ] Handle a partial grant — render what you can, explain the rest in your own UI.
- [ ] Handle `permission_revoked` and the `permission.changed` event live (§8).
- [ ] Remove any form where you asked the user to re-type their name/email.
- [ ] Images from GFS go in `<img src="{dataUrl}">`; `blob:` will not load (§7.6).
- [ ] Nothing to add to the recipe YAML. No new Secrets. No new egress.

---

## 2. Requirements

|             |                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Desktop App | The build that ships the Plugin UI SDK. Feature-detect rather than assume.                       |
| Recipe      | Any recipe with `spec.ui` (§6 of the WorkflowRecipe guide). **No YAML changes.**                 |
| Install     | The operator installs and grants the plugin as usual; the user approves capabilities at runtime. |
| Protocol    | `1`. `window.clerum.sdk.version` is `'1.0.0'`.                                                   |

The SDK is only present inside the Desktop App's embed. The same bundle opened
in a browser tab has no `window.clerum` — always feature-detect:

```js
const inEvenfire = typeof window.clerum?.sdk?.requestPermissions === 'function'
```

---

## 3. The shape of every call

Every method resolves an envelope. It never rejects, so `try/catch` is not how
you handle a denial:

```ts
type Response<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }
```

Error codes you should actually branch on:

| Code                     | What it means for you                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `permission_denied`      | The user said no, or has not been asked yet. Render your "connect" state.                         |
| `permission_revoked`     | They had granted it and took it back. Say so; do not silently re-prompt.                          |
| `unauthenticated`        | No Desktop session. Retry after `session.changed`.                                                |
| `rate_limited`           | You are polling too fast. Back off; the message carries a hint.                                   |
| `unsupported_capability` | Older Desktop build. Degrade.                                                                     |
| `invalid_request`        | Your params are wrong — a bug in your plugin, not a user state.                                   |
| `not_found`              | The `gfs://` resource does not exist _or_ the user cannot see it. Deliberately indistinguishable. |
| `payload_too_large`      | The result exceeded the capability's cap.                                                         |
| `unavailable`            | Upstream hiccup. `retryable: true`.                                                               |

---

## 4. Capabilities

| Capability             | Returns                                                                       | Prompt shown to the user                                                     |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `identity.read`        | `{ userId, email, name }`                                                     | "See who you are — your name, email address, and user id."                   |
| `org.read`             | `{ teamId, teamName, role }`                                                  | "See your current team — its name and your role in it."                      |
| `agents.read`          | `{ agents: [{ id, name, contextRef, provider, mcpServers[] }] }`              | "See the agents you have access to…"                                         |
| `contexts.read`        | `{ contexts: [{ id, scope }] }`                                               | "See the contexts you have access to."                                       |
| `mcp.read`             | `{ servers: [{ name, agents[] }] }`                                           | "See the MCP servers you have access to…"                                    |
| `gfs.list`             | `{ items: [{ resourceId, gfsUri, name, kind, bytes, version }], nextCursor }` | "See the shared files you have access to… It will not be able to open them." |
| `gfs.read`             | `{ gfsUri, name, mimeType, bytes }` + `text` or `dataUrl`                     | "Open shared files you have access to…"                                      |
| `theme.read`           | `{ theme: 'light' \| 'dark' }`                                                | **No prompt** — it says nothing about the user.                              |
| `notifications.notify` | `{ delivered, reason? }`                                                      | "Send you notifications."                                                    |

What you will notice is missing, and why:

- **No avatar URL** on `identity.read`. The embed CSP is `img-src 'self' data:`,
  so you could not render a remote image anyway.
- **No `url`** on `mcp.read` servers. `connect-src 'self'` means you cannot call
  them, and shipping cluster-internal URLs into an embed is a bad trade.
- **No writes.** Every capability is a read except `notifications.notify`.

---

## 5. Asking for permissions

### 5.1 Batch. Always batch.

The unit of consent is the **prompt**, not the capability. Ask for your whole
startup set in one call and the user sees one modal with one row per capability,
each individually declinable.

There is an anti-fatigue budget of **3 modals per plugin per session** and a 10 s
cooldown between them (§9.5). A plugin that asks one capability at a time burns
that budget in three calls and then gets `permission_denied` for everything else
until the user reopens it. A plugin that batches spends one.

```js
// GOOD — one modal.
await window.clerum.sdk.requestPermissions(['identity.read', 'org.read', 'agents.read'])

// BAD — three modals, thirty seconds of cooldown, budget exhausted.
await window.clerum.identity.get()
await window.clerum.org.get()
await window.clerum.agents.list()
```

Up to **8** capabilities per batch. Duplicates, unknown ids, and oversized lists
are rejected as `invalid_request` before any modal renders.

### 5.2 Check before you ask

`sdk.permissions()` reads grant state without prompting. Use it on every boot:
after the first run, a returning user should see your full UI with **no modal at
all**.

```js
const { data } = await window.clerum.sdk.permissions(NEED) // no prompt
const missing = NEED.filter(id => !data.granted[id])
```

Called with no argument it returns state for every capability the host knows.

### 5.3 Handle a partial grant

`requestPermissions` resolves with a map, not an error, even if the user declines
everything:

```js
const res = await window.clerum.sdk.requestPermissions(missing)
// res.data = { granted: { 'identity.read': true, 'gfs.list': false }, all: false }
```

**You cannot mark a row "required".** If your plugin genuinely needs all of them,
say so in your own UI after the fact — the host will not lend its chrome to that
pressure (§9.2). Render what you can and put a clear affordance where the missing
piece would be.

### 5.4 What the user experiences

When a prompt opens, **your embed is hidden** for its duration. That is
deliberate: a `WebContentsView` paints above the renderer's DOM regardless of
z-index, so hiding it is the only way to guarantee you cannot fake or cover the
prompt (§9.4). Consequences for you:

- Do not fire `requestPermissions` from inside an animation or a drag.
- Your page keeps running; only its pixels are hidden. Timers still tick.
- If the Desktop window is not focused, the prompt parks until it is.

### 5.5 If the user denies

The denial sticks **for the rest of the session**, and further calls return
`permission_denied` immediately with no prompt. Reopening the plugin gives you one
more chance to ask.

> ⚠ **Known rough edge.** A "Grant access" button in your own UI will do nothing
> in the same session after a denial — the SDK will not re-prompt. Until this is
> resolved (§16 #6 of the design spec), point the user at **Settings → Plugin
> permissions**, or ask them to close and reopen the plugin.

---

## 6. Wiring it into a plugin

### 6.1 A complete boot sequence

```js
// app.js — external, same-origin. CSP forbids inline <script>.
const NEED = ['identity.read', 'org.read', 'agents.read']

async function boot() {
  if (!window.clerum?.sdk) return renderStandalone() // not inside Evenfire

  // Only ask for what is actually missing.
  const state = await window.clerum.sdk.permissions(NEED)
  const missing = state.ok ? NEED.filter(id => !state.data.granted[id]) : NEED

  if (missing.length) {
    const res = await window.clerum.sdk.requestPermissions(missing)
    if (!res.ok) return renderError(res.error.message)
  }

  const [me, org, agents] = await Promise.all([
    window.clerum.identity.get(),
    window.clerum.org.get(),
    window.clerum.agents.list(),
  ])

  renderHeader({
    name: me.ok ? (me.data.name ?? me.data.email) : null,
    team: org.ok ? org.data.teamName : null,
  })
  renderAgentPicker(agents.ok ? agents.data.agents : [])
  if (!agents.ok) showInlineNotice('Allow agent access to target a specific agent.')
}

window.clerum?.sdk?.on(event => {
  if (event.type === 'permission.changed' && !event.granted) boot()
  if (event.type === 'session.changed') boot()
  if (event.type === 'theme.changed') document.documentElement.dataset.theme = event.theme
})

boot()
```

### 6.2 Telling your backend who the user is

**Do not** POST the identity you got from the SDK to your backend and trust it —
your own embed JS is not a trustworthy source of identity.

Your backend already receives `X-Clerum-User`, injected by rpc-proxy and
un-spoofable from the embed (§6.3 of the WorkflowRecipe guide). That remains the
authority for anything security-relevant.

| Use the SDK's identity for         | Use `X-Clerum-User` for           |
| ---------------------------------- | --------------------------------- |
| Greeting the user by name          | Deciding which rows they may read |
| Pre-filling a form field           | Writing an audit record           |
| Choosing a default agent in the UI | Authorizing anything at all       |

The SDK gives you a _display_ identity and the user's own view of their
workspace. It is not an authentication mechanism.

### 6.3 Migrating away from a re-typed email

Before:

```html
<label>Your work email <input id="email" required /></label>
```

After:

```js
const me = await window.clerum.identity.get()
if (me.ok) {
  emailInput.value = me.data.email
  emailInput.readOnly = true
} else {
  // Not granted — keep the manual field as the fallback path.
  emailInput.readOnly = false
}
```

Keep the fallback. A user who declines identity should still be able to use your
plugin, just with more typing.

---

## 7. Per-capability notes

### 7.1 `identity.read`

`name` can be `null` — plenty of accounts have no display name. Fall back to
`email`. `userId` is stable and is the right key for per-user state your plugin
stores server-side.

### 7.2 `org.read`

If the user switches teams, an existing grant keeps working and starts returning
the **new** team. A `session.changed` event fires; refetch rather than caching
the team forever.

### 7.3 `agents.read`

`id` is the stable grant-target id (`1st:<ns>/<name>`) when the server provides
one, otherwise `name`. Use `id` as your key and `name` for display.
`mcpServers` is a flat array of names.

### 7.4 `contexts.read`

`scope` is `'user'` or `'team'`. A context reachable both ways reports `'user'`.

### 7.5 `mcp.read`

`agents` lists which of the user's agents can invoke that server; it can be empty
on older clusters that do not return the enrichment.

### 7.6 `gfs.list` / `gfs.read`

Listing and opening are **separate grants**. A plugin that only shows a file
picker should ask for `gfs.list` alone.

```js
const page = await window.clerum.gfs.list({ drive: 'main' }) // top level
const kids = await window.clerum.gfs.list({ resourceId: 'abc…' }) // a folder
// Paginate with the cursor:
const more = await window.clerum.gfs.list({ cursor: page.data.nextCursor })
```

**Rendering an image** — this is the one API whose shape is dictated by the CSP:

```js
const res = await window.clerum.gfs.read({ uri: 'gfs://main/reports/q3.png', as: 'dataUrl' })
if (res.ok) img.src = res.data.dataUrl
```

- `data:` URIs only. **`blob:` is not in the embed's `img-src` and will not
  load** — do not convert.
- Renderable types: PNG, JPEG, GIF, WebP, AVIF. **SVG is refused** on purpose;
  ship vector art in your own bundle.
- The bytes are checked against their magic numbers, so a `.png` that is not a
  PNG is refused with `invalid_request`.
- 10 MB ceiling for images, 2 MB for `as: 'text'`; over that is
  `payload_too_large`.
- `as: 'text'` refuses non-UTF-8 bytes rather than handing you replacement
  characters.

### 7.7 `theme.read`

No prompt. Pair it with the `theme.changed` event rather than polling:

```js
const t = await window.clerum.theme.get()
if (t.ok) document.documentElement.dataset.theme = t.data.theme
window.clerum.sdk.on(e => {
  if (e.type === 'theme.changed') document.documentElement.dataset.theme = e.theme
})
```

### 7.8 `notifications.notify`

```js
await window.clerum.notifications.notify({
  title: '3 new inbound leads',
  body: 'Two are from existing accounts.',
  ref: 'inbox/2026-08-06', // opaque to the host; echoed back on click
})
```

- The user sees **"{Your plugin title} — {your title}"**. Attribution is
  mandatory; you cannot present as Evenfire or as another plugin.
- **Suppressed while the user is looking at your plugin** — you get
  `{ delivered: false, reason: 'suppressed' }`, which is not an error.
- Plain text only; control characters are stripped. Title ≤ 120 chars, body ≤ 400.
- Rate limit is the tightest in the SDK: **2/min, 20/hour**. This is the only API
  that can make noise outside the app.
- On click, the window focuses, the Desktop navigates to your plugin, and your
  embed receives `{ type: 'notification.clicked', ref }` if it is mounted.

---

## 8. Events

```js
const off = window.clerum.sdk.on(event => {
  /* … */
})
// off() to unsubscribe
```

| Event                  | When                            | What you should do                                          |
| ---------------------- | ------------------------------- | ----------------------------------------------------------- |
| `theme.changed`        | User switched light/dark        | Restyle.                                                    |
| `permission.changed`   | A grant was revoked in Settings | Drop back to the ungranted rendering **without reloading**. |
| `session.changed`      | Login, logout, team switch      | Refetch everything.                                         |
| `notification.clicked` | User clicked your notification  | Route to `ref`.                                             |

Subscribing costs nothing and needs no permission.

The pre-existing `clerum.onOauthCompleted()` and `clerum.requestSessionRefresh()`
are unchanged and stay on their own channels. Existing plugins keep working with
no edits.

---

## 9. Rate limits

| Capability                                 | per minute | per hour |
| ------------------------------------------ | ---------- | -------- |
| `identity.read`, `org.read`                | 10         | 60       |
| `agents.read`, `contexts.read`, `mcp.read` | 10         | 120      |
| `gfs.list`                                 | 30         | 600      |
| `gfs.read`                                 | 20         | 300      |
| `theme.read`                               | 60         | 600      |
| `notifications.notify`                     | 2          | 20       |

Plus **120 requests/minute** across all capabilities per plugin, so round-robin
does not get you extra budget.

Identity, org, agents, contexts, and MCP results are cached in the Desktop for
30–60 s, so re-reading is cheap — but a cache hit still costs a token. Fetch on
boot and on `session.changed`, not on a timer.

---

## 10. What the user can see about you

**Settings → Plugin permissions** lists every plugin holding a grant, the exact
scope sentences they approved, when each was last used, and a **Revoke** button.
An **Activity** tab shows what your plugin requested and what happened —
including denials and rate-limits.

Two things follow for you:

1. **Ask for what you use.** A plugin holding `gfs.read` it never calls looks
   worse in that list than one that never asked.
2. **Revocation is live.** Handle `permission.changed` gracefully; you will not
   be reloaded.

The audit log records the _shape_ of what you received (field names, counts,
byte sizes), never the values.

---

## 11. Testing your plugin

Without a full cluster you can still exercise every branch by stubbing the global
before your bundle loads:

```js
window.clerum = {
  sdk: {
    version: '1.0.0',
    capabilities: async () => ({ ok: true, data: { capabilities: ['identity.read'] } }),
    permissions: async () => ({ ok: true, data: { granted: { 'identity.read': false } } }),
    requestPermissions: async ids => ({
      ok: true,
      data: { granted: Object.fromEntries(ids.map(id => [id, true])), all: true },
    }),
    on: () => () => {},
  },
  identity: {
    get: async () => ({ ok: true, data: { userId: 'u1', email: 'a@b.c', name: 'A' } }),
  },
}
```

Branches worth covering, because each is a state a real user will hit:

- First run: `permissions()` all false → one `requestPermissions` → full UI.
- Returning user: all true → **no** `requestPermissions` call at all.
- Partial grant: `all: false` → your reduced UI plus an explanation.
- Full denial: everything false → your "needs access" state.
- Revocation mid-session: `permission.changed` → same reduced UI, no reload.
- Older Desktop: `window.clerum.sdk` undefined → standalone rendering.

---

## 12. Troubleshooting

| Symptom                                                       | Cause                                                                | Fix                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `window.clerum.sdk` is undefined                              | Older Desktop, or not running inside the Desktop                     | Feature-detect and degrade.                            |
| Every call returns `permission_denied`, no modal ever appears | The user denied earlier this session, or your prompt budget is spent | Reopen the plugin. Batch your asks.                    |
| The modal never appears and the call hangs, then denies       | Desktop window is not focused                                        | The prompt parks until focus, then times out at 120 s. |
| `invalid_request` on a call that "looks right"                | An unexpected param key. Validators reject unknown keys outright     | Check the params table for that capability.            |
| Image never renders, no console error                         | You converted the `dataUrl` to a `blob:` URL                         | Assign `dataUrl` straight to `img.src`.                |
| `not_found` on a `gfs://` link that exists                    | The user cannot see it — deliberately indistinguishable from absent  | Ask them to check their access in Files.               |
| `rate_limited` right after boot                               | Polling in a `useEffect` without deps, or per-render fetches         | Fetch on boot and on events.                           |
| Notification never appears                                    | The user is looking at your plugin                                   | Check `reason: 'suppressed'`; not an error.            |
| Identity works but your backend rejects the user              | You sent the SDK identity to your backend and trusted it             | Use `X-Clerum-User` server-side.                       |

---

## 13. Reference

| Subject                                           | File                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| Design + threat model                             | `docs/features/plugin-ui-sdk-1.md`               |
| Wire contract, channels, error codes              | `desktop-app/src/pluginSdkProtocol.ts`           |
| Capability catalog (authoritative payload shapes) | `desktop-app/src/pluginSdkCapabilities.ts`       |
| Injected global                                   | `desktop-app/src/sandboxUiEmbedPreload.ts`       |
| Gating order                                      | `desktop-app/src/pluginSdkBroker.ts`             |
| Consent behaviour                                 | `desktop-app/src/pluginConsentGate.ts`           |
| Recipe/`spec.ui` rules, CSP, egress               | `docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md` §6 |

When this guide and the code disagree, the code wins.
