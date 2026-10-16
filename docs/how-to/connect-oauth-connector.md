# How to: connect an OAuth connector and manage connector credentials

Some connectors (MCP servers) authenticate with OAuth instead of a static API
key. For these, an operator installs the connector once, and each user (or one
member of a Context) authorizes it in the browser. control-api keeps the
tokens. This page covers that flow, then the second half of the topic:
setting and rotating credentials for connectors that use a static Secret.

Field-by-field reference: [McpServer CRD, OAuth (`spec.oauth`)](../crds/mcpserver.md#oauth-specoauth).

## Mental model

1. An operator installs an `McpServer` with `spec.auth.type: oauth` and a
   `spec.oauth` block. No token is stored on the resource.
2. A user authorizes it in the Desktop app. The provider redirects back to
   control-api's OAuth callback, and control-api stores the grant encrypted
   (AES-256-GCM, access and refresh tokens).
3. When an agent calls a tool on that server, mcp-host asks control-api's
   broker for a token for that connection and sends it as an
   `Authorization: Bearer` header on the request.
4. If no grant exists, the task pauses and the chat shows a **Connect** prompt
   instead of Approve/Deny.

Tokens are never mounted into the connector pod. host-context-controller only
hashes and mounts the static `spec.envSecret`. For remote servers, the egress
proxy it generates passes the per-request `Authorization` header through. It
also rejects an OAuth server that pins a static `Authorization` header.

## Prerequisites

| Setting (control-api)                                                     | Default                                                                                                                                           | What happens if it is wrong                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_OAUTH_BROKER_ENABLED`                                                | **Off** in `deploy/base`, `true` in the minikube overlay                                                                                          | The token broker answers `404`, mcp-host reads that as "no grant", and the agent asks for consent forever, even after the user authorizes. Accepts only `true` or `false`.                                                                                                                                                                                                                                                                                             |
| `CONTROL_API_OAUTH_CALLBACK_BASE_URL`                                     | Unset in base, `http://127.0.0.1:8090` in minikube                                                                                                | Must be the bare, browser-reachable origin that routes `/api/v1/oauth-callback/` to control-api (and, for CIMD, `/api/v1/.well-known/evenfire-mcp-client`; see the gateway limitation below). When unset, control-api builds the redirect URI from the request Host, which is usually an internal hostname. Marketplace built-in and generic installs, and remote installs that use CIMD, DCR, or a per-server callback (no RFC 9207), are rejected while it is unset. |
| `CONTROL_API_OAUTH_STATE_HMAC_SECRET`, `CONTROL_API_OAUTH_ENCRYPTION_KEY` | Built-in dev values only when `NODE_ENV` is not `production` (production refuses to start without them); read from the control-api Secret in base | Generate real values (`deploy/scripts/gen-jwt-keys.sh` does this). The encryption key protects stored grants.                                                                                                                                                                                                                                                                                                                                                          |
| `OAUTH_PROACTIVE_REFRESH_CRON_ENABLED`                                    | **Off**, including in minikube                                                                                                                    | Remote-server tokens are only refreshed when someone uses them. See [Refresh and background use](#refresh-and-background-use).                                                                                                                                                                                                                                                                                                                                         |

The Control UI **Marketplace** OAuth install form (built-in and generic
providers) reads the redirect URI from control-api at runtime
(`GET /admin/oauth/callback`), so it always matches
`CONTROL_API_OAUTH_CALLBACK_BASE_URL`. While that setting is unset, the form
shows "not configured" and keeps **Install connector** disabled.

The desktop app opens the provider's authorize URL only if it uses `https:`.

## Three ways to configure OAuth

| Style                               | `spec.oauth.source`                                                                                                      | How you install it                                               | Redirect URI to register                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in provider adapter           | absent; `provider` is one of `salesforce`, `slack`, `notion`, `microsoft-graph`, `google`, `monday`, `clickup`, `vercel` | YAML, or the Marketplace OAuth form                              | `<CALLBACK_BASE>/api/v1/oauth-callback/<oauth.id>`                                                                                          |
| Remote MCP server (discovery)       | `remote`                                                                                                                 | Control UI **Add remote server** wizard                          | `/api/v1/oauth-callback/remote` if the authorization server supports RFC 9207 `iss`; otherwise `/api/v1/oauth-callback/remote/<serverName>` |
| Generic, operator-configured client | `generic`                                                                                                                | YAML, or the Marketplace OAuth form (adds an **Endpoints** step) | `<CALLBACK_BASE>/api/v1/oauth-callback/<oauth.id>`                                                                                          |

Endpoints for `remote` and `generic` must use `https` and a public host. Hosts
that resolve to private, metadata, link-local, or reserved addresses are
rejected.

`source`, `provider`, `oauth.id`, and `grantScope` cannot be changed after
creation. To change one, delete the connector and install it again.
Reinstalling invalidates existing grants: grants are bound to the McpServer's
UID, so users must authorize again.

### Who holds the grant: `grantScope`

- **`user`** (default; shown as **Per user**): each user authorizes their own
  account. One grant per user covers every agent of theirs that uses this
  connector.
- **`context`** (shown as **Per context** / **Shared (context)**): one shared
  grant per Context. Any member authorizes it, and every agent in that Context
  then acts with that identity. Desktop asks the user to confirm before
  connecting or disconnecting a shared grant.

Users can only authorize or disconnect servers whose `spec.contextRef` is a
Context they belong to. Otherwise the request fails with
`context_membership_denied`.

## Operator: add a remote MCP server (Control UI)

1. Open **Connectors** (`/connectors`) and click **Add remote server**
   (`/connectors/remote/new`).
2. **Identify**: enter the **Remote server URL** (for example
   `https://mcp.example.com/mcp`), a **Server name** (a Kubernetes name), and
   the **Context** to attach the server to. Click **Detect**.
   control-api runs RFC 9728/8414 discovery and probes the MCP endpoint. If the
   endpoint is unreachable, the wizard stays on this step and may suggest the
   correct URL.
3. **Configure**: review the detected issuer, endpoints, scopes, and
   **Registration mode**. The mode is picked in this order:
   - **Client ID Metadata Document (public client)**: no credentials. Picked
     automatically when the server supports RFC 9207 `iss`, advertises CIMD,
     and accepts public clients. The client ID is a URL on your callback
     origin (`<CALLBACK_BASE>/api/v1/.well-known/evenfire-mcp-client`), which
     control-api serves, so the authorization server must be able to fetch it
     from the internet.

     > **Gateway limitation.** The public gateway shipped in `deploy/base`
     > (the nginx config in `deploy/base/profiles/configmaps.yaml`) forwards
     > only `/api/v1/external/` and `/api/v1/oauth-callback/` to control-api
     > and answers `403` for every other path, including the client document. Behind that gateway,
     > CIMD authorization fails because the authorization server cannot fetch
     > the client ID. Until the gateway ships this route (tracked as a
     > follow-up), add a route that forwards
     > `/api/v1/.well-known/evenfire-mcp-client` to control-api in your
     > gateway or ingress. Minikube does not use this gateway: its callback
     > origin is a loopback port-forward to control-api, which serves the
     > path, but an authorization server on the internet cannot fetch a
     > loopback URL.
   - **Dynamic Client Registration**: control-api registers a client and stores
     its credentials encrypted. You do not supply any.
   - **Pre-registered client required**: register an OAuth app at the provider
     with the **Redirect URI** the wizard shows, then paste its **Client ID**
     and **Client secret**.

   Choose the **Grant scope**: **Per user** (recommended) or **Per context**.

4. **Confirm**: review the summary and click **Install remote server**. If the
   mode is pre-registered, the wizard shows the final redirect URI again.
   Register exactly that URI. If the authorization server changed since
   detection, the wizard warns that the URI is different.

The install creates the client Secret (pre-registered only), the McpServer, and
the Context attachment, and rolls back if a step fails. The resulting
McpServer runs the platform egress proxy image (`clerum/nginx-egress-proxy`)
with an exact-host egress binding to port 443 of the remote host. API
equivalents: `POST /api/v1/admin/mcp-servers/remote/discover` (dry run) and
`POST /api/v1/admin/mcp-servers/remote`.

## Operator: built-in or generic provider (YAML)

Create an OAuth app at the provider, register the redirect URI, and store the
client credentials in a Secret in the MCP server namespace:

```yaml
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: notion
  namespace: mcp-server
spec:
  contextRef: context1
  # image, transport, egress: see the CRD reference
  auth:
    type: oauth # forbids auth.secretRef / auth.secretKey
  oauth:
    id: notion-mcp # callback path segment, immutable
    provider: notion
    clientIdRef: { name: notion-oauth-client, key: client_id }
    clientSecretRef: { name: notion-oauth-client, key: client_secret }
    scopes: [...] # provider-specific
    grantScope: user
```

Redirect URI for this example:
`<CONTROL_API_OAUTH_CALLBACK_BASE_URL>/api/v1/oauth-callback/notion-mcp`.
For `generic`, set `source: generic` and add the endpoint and wire fields
listed in the [CRD reference](../crds/mcpserver.md#oauth-specoauth).

If the client Secret or one of its keys is missing, authorization fails with
`503 integration_not_configured`, and the error message names the missing
Secret.

## End user: authorize, use, disconnect

**Ahead of time:** in the Desktop app, open **Connectors**. There is one row
per connector and agent, and each row shows **Authorized**, **Requires setup**,
or **No OAuth**. Click **Authorize** to open the provider's consent page in your
system browser. A connector you already authorized shows **Disconnect**.
Connectors with static credentials (**No OAuth**) have no button.

**In chat:** if an agent calls a tool on an OAuth connector you have not
authorized, the task pauses and the progress card shows
**Connect \<server\> to continue**. Clicking **Connect \<server\>** opens the
same browser consent. When the browser hands control back to the app
(`clerum://oauth-completed`), the paused task continues. The pause survives an
mcp-host restart.

## Refresh and background use

- **Refresh on use:** when a stored access token is within 60 seconds of
  expiry, control-api refreshes it before returning it. If there is no refresh
  token, or a remote or generic server was installed with
  `supportsRefresh: false`, the user is asked to connect again.
- **Proactive refresh** of remote-server grants runs only when
  `OAUTH_PROACTIVE_REFRESH_CRON_ENABLED=true`. It is off by default.
- **`backgroundAccess`** is a field on the spec (see the CRD reference). The
  broker path agents use today requests tokens as a live session, so do not
  count on unattended access without testing it in your environment. If you
  need refresh, request the provider's offline or refresh scope.

## Disconnect and revoke

- **User:** **Disconnect** on the Desktop Connectors page. Desktop asks for
  confirmation, then calls `DELETE /api/v1/mcp-oauth/<server>/grant` through
  rpc-proxy, which deletes the stored grant. For a **Per context** connector,
  this removes access for everyone in the Context.
- **Admin (API only, no Control UI screen):**
  `GET /api/v1/admin/mcp-servers/<name>/oauth/user-grants` lists users with a
  grant. `DELETE /api/v1/admin/mcp-servers/<name>/oauth/user-grants/<userId>`
  with body `{ "oauthClientId": "..." }` force-revokes one user's grant.
- **Limits:** revocation deletes evenfire's copy of the grant. It does not call
  the provider's revocation endpoint, so revoke the app at the provider too if
  you need that. Sessions that are already running may keep a cached token
  for a while. Desktop warns that "active sessions end on the next revocation
  sweep."

## Part 2: credentials for static-credential connectors

Connectors that use API keys read them from the Secret named in
`spec.envSecret` (in the MCP server namespace). OAuth connectors do not use
this flow. Their **Credentials** tab shows the client configuration read-only,
and rotating an OAuth client secret is not available in Control UI.

### Install now, add credentials later

When you install a connector from the **Marketplace**, leave every credential
field empty to install it without credentials. A partly filled form is
rejected. host-context-controller then sets the condition
`SecretResolved=False` (reason `SecretNotFound`) and does not deploy the
connector. **Connectors** shows the badge **Missing Secret**.

```bash
kubectl get mcpserver <name> -n mcp-server \
  -o jsonpath='{.status.conditions[?(@.type=="SecretResolved")]}'
```

### Set or rotate credentials

Open the connector, click **Edit connector**, and select the **Credentials**
tab (`/connectors/<name>/edit`). The tab lists each Secret key and its
environment variable. Stored values are never shown.

- **Secret missing** (`SecretNotFound`): the section is **Set credentials**.
  Fill every key, click **Set credentials**, then confirm with **Set & start**.
  This creates the Secret, and the connector starts.
- **Secret exists** (including `SecretMissingKey`): the section is
  **Update credentials**. Fill only the keys you want to change; blank fields
  keep their current value. Click **Rotate credentials**, then confirm with
  **Rotate & restart**.

Rotation calls `PUT /api/v1/admin/mcp-secrets/<name>` with `{ "data": { ... } }`.
This is a server-side merge patch: the keys you send are added or replaced, and
every other key stays. Empty values are rejected, and the response never echoes
values. It also returns `affectedConnectors`: every McpServer whose
`spec.envSecret` uses this Secret. Secrets owned by a WorkflowRecipe are
refused (`409`).

control-api does not restart anything itself. host-context-controller watches
Secrets, recomputes a SHA-256 of the Secret data, and writes it to the pod
template annotation `clerum.io/credentials-revision`. Every affected Deployment
then rolls out. The Control UI waits up to 180 seconds for this connector's
Deployment to become ready again. Other connectors that share the Secret roll
out too, but the screen only tracks the current one.

## Troubleshooting

| Symptom                                                                             | Likely cause                                                                                                   | Fix                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent keeps asking to **Connect** after the user authorized                         | `MCP_OAUTH_BROKER_ENABLED` is not `true`                                                                       | Set it on control-api and restart                                                                        |
| Provider says `redirect_uri` mismatch                                               | Callback base is unset or wrong, or the registered URI differs from the one shown                              | Set `CONTROL_API_OAUTH_CALLBACK_BASE_URL` to the public origin. Register the exact URI the wizard shows. |
| Remote install returns `callback_base_url_unconfigured`                             | CIMD, DCR, or a server without RFC 9207 needs the public callback origin                                       | Set `CONTROL_API_OAUTH_CALLBACK_BASE_URL`                                                                |
| CIMD authorization fails; the authorization server cannot fetch the client ID       | The gateway does not route `/api/v1/.well-known/evenfire-mcp-client` (the `deploy/base` gateway returns `403`) | Forward that path to control-api in your gateway or ingress                                              |
| **Detect** stops with an unreachable transport (`transport_unreachable` on install) | The URL is not the MCP endpoint                                                                                | Use the URL the wizard suggests, or the server's documented MCP path                                     |
| Marketplace OAuth form says the callback URL is not configured                      | `CONTROL_API_OAUTH_CALLBACK_BASE_URL` is unset on control-api                                                  | Set it, restart control-api, and reload the form                                                         |
| `503 integration_not_configured`                                                    | The client ID or secret Secret, or one of its keys, is missing                                                 | Create the Secret the hint names                                                                         |
| `403 context_membership_denied`                                                     | The user is not a member of the server's Context                                                               | Add the user to the Context                                                                              |
| Users must authorize again after a reinstall                                        | Grants are bound to the old McpServer UID                                                                      | Expected                                                                                                 |
| Connector shows **Missing Secret**                                                  | `SecretResolved=False`                                                                                         | Use **Set credentials** on the **Credentials** tab                                                       |
| Rotation restarted other connectors                                                 | They share the same `envSecret`                                                                                | Expected. Check `affectedConnectors`.                                                                    |

## Related

- [McpServer CRD: OAuth and status conditions](../crds/mcpserver.md#oauth-specoauth)
- [Add an MCP server](add-mcp-server.md)
- [Configure approvals](configure-approvals.md)
- [Control UI](../surfaces/control-ui.md) and [Desktop app](../surfaces/desktop-app.md)
