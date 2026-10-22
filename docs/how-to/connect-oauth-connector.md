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
| `CONTROL_API_OAUTH_CALLBACK_BASE_URL`                                     | Unset in base, `http://127.0.0.1:8090` in minikube                                                                                                | Must be the bare, browser-reachable origin that routes `/api/v1/oauth-callback/` to control-api (and, for CIMD, `/api/v1/.well-known/evenfire-mcp-client`; see the gateway note below). When unset, control-api builds the redirect URI from the request Host, which is usually an internal hostname. Marketplace built-in and generic installs, and remote installs that use CIMD, DCR, or a per-server callback (no RFC 9207), are rejected while it is unset. |
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
   correct URL. If the server signs in through Microsoft Entra ID, the wizard
   asks for your tenant ID first; see
   [Microsoft 365 / Entra ID](#microsoft-365--entra-id).
3. **Configure**: review the detected issuer, endpoints, and
   **Registration mode**. **Scopes** starts with the scopes the server
   advertises; edit the space-separated list if needed, or clear it to go back
   to the advertised ones. The mode is picked in this order:
   - **Client ID Metadata Document (public client)**: no credentials. Picked
     automatically when the server supports RFC 9207 `iss`, advertises CIMD,
     and accepts public clients. The client ID is a URL on your callback
     origin (`<CALLBACK_BASE>/api/v1/.well-known/evenfire-mcp-client`), which
     control-api serves, so the authorization server must be able to fetch it
     from the internet.

     > **Gateway route.** The public gateway shipped in `deploy/base` (the
     > nginx config in `deploy/base/profiles/configmaps.yaml`, reached through
     > external-rest-api) forwards `GET` and `HEAD` for exactly
     > `/api/v1/.well-known/evenfire-mcp-client` to control-api, alongside
     > `/api/v1/external/` and `/api/v1/oauth-callback/`. If you put your own
     > gateway or ingress in front of control-api instead, forward that path
     > too. Minikube does not use this gateway: its callback origin is a
     > loopback port-forward to control-api, which serves the path, but an
     > authorization server on the internet cannot fetch a loopback URL.
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

## Microsoft 365 / Entra ID

Microsoft 365 MCP servers sign users in with Microsoft Entra ID. You add them
with the same **Add remote server** wizard, but Entra needs a tenant ID, a
pre-registered app, and scopes that name the server's own API. This section
covers [Work IQ](#work-iq-recommended), which is the recommended server, and
the [Agent 365](#agent-365-legacy-not-verified) per-app servers, which
Microsoft marks as legacy.

> **Pending end-to-end verification.** This flow is covered by automated
> tests built from metadata captured from Microsoft's servers, but it has not
> yet been run end to end against a real tenant. Which scope form Work IQ
> accepts is not settled yet, and Agent 365 is **not verified**.

### What changes with Entra ID

- **Tenant ID.** These servers advertise Entra's multi-tenant authority
  (`https://login.microsoftonline.com/organizations/v2.0`), whose metadata
  cannot be matched to a single issuer. After **Detect**, the wizard asks for
  the **Microsoft Entra tenant ID**: the **Directory (tenant) ID** on the
  Microsoft Entra admin center overview. Enter it as a GUID. A domain name
  such as `contoso.com` is refused, because Entra reports the issuer with the
  GUID and a domain could never match it. The wizard lowercases the GUID and
  detects again against `https://login.microsoftonline.com/<tenant-id>/v2.0`.
  A tenant Entra does not know shows "Microsoft Entra ID did not recognize
  this tenant ID". The override is accepted only for Entra: control-api
  rejects a tenant authority for a server that does not advertise Entra's
  multi-tenant authority, and any other authorization server address.
- **One install per tenant.** The tenant is pinned at install, and users sign
  in against it. To serve several tenants, install the server once per tenant,
  each with its own server name and app registration.
- **Authorization server profile.** The Configure step shows
  **Authorization server: Microsoft Entra ID**, and the McpServer is
  installed with `spec.oauth.asProfile: entra-v2`. With this profile,
  control-api:
  - uses PKCE (S256) and refresh tokens. Entra supports both but does not
    advertise them in its metadata;
  - always adds `offline_access`, because Entra only issues a refresh token
    when it is requested. You do not need to type it;
  - does not send the RFC 8707 `resource` parameter, because Entra picks the
    token's audience from the scopes and rejects a `resource` that disagrees.
    The wizard shows the resource as "(not sent to Microsoft Entra ID)";
  - sends the installed scopes on the code exchange and on every refresh, so
    the installed scopes, not the authorize URL that passes through the
    browser, decide which API the token is for.
- **Pre-registered client.** Entra offers neither dynamic registration nor a
  client ID metadata document, so the mode is **Pre-registered client
  required**. Use a client secret. Certificate credentials are not supported.
- **Grant scope.** Use **Per user** for Microsoft 365, so each user's agents
  act with that user's own mailbox, files, and permissions.

### App registration: one per server

In the Microsoft Entra admin center, under **App registrations**, create a
separate app registration for each MCP server (Work IQ, Agent 365 Mail,
Agent 365 Calendar, and so on):

1. **Platform: Web.** Add the redirect URI the wizard shows, exactly:
   `<CONTROL_API_OAUTH_CALLBACK_BASE_URL>/api/v1/oauth-callback/remote/<serverName>`.
   Entra accepts an `http` redirect URI only with `localhost`, so on a local
   cluster use `http://localhost:<port>` as the callback base.
2. **Client secret.** Create one under **Certificates & secrets**, and paste
   it with the **Application (client) ID** into the wizard.
3. **API permissions.** Remove the Microsoft Graph `User.Read` permission that
   Entra adds by default. Add only the delegated permission of this server,
   then **Grant admin consent**.
4. **Block user consent for the app.** Entra lets users consent at sign-in to
   permissions the app registration does not list, so the permission list is
   not a ceiling on its own. It becomes one when users cannot consent: set
   the tenant's user consent setting to **Do not allow user consent**
   (Enterprise applications > Consent and permissions > User consent
   settings), or use an app consent policy that excludes this app. Then the only permission a token can carry is the one
   an administrator consented to.

control-api refuses to install a second server with the same client ID
(`409 oauth_client_id_in_use`), so reusing one app registration across servers
is not possible.

### Scopes and audience

Because the `resource` parameter is not sent, the scopes alone decide which
API a token is issued for, and mcp-host sends that token to the MCP server.
control-api therefore checks every scope against the host of the server URL
before it installs anything. The scopes come from the server's metadata or
from you, and both are checked the same way.

| Scope                                                                                                                                                                                                                                                                                              | Result                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `openid`, `profile`, `email`, `offline_access`                                                                                                                                                                                                                                                     | Allowed, but not enough on their own (see below).                    |
| `https://<server-host>/...` or `api://<server-host>/...`, where `<server-host>` is exactly the host of the server URL                                                                                                                                                                              | Accepted.                                                            |
| GUID form (`<guid>/<permission>` or `api://<guid>/<permission>`, lower-case GUID) of a Microsoft MCP API on its own host: Work IQ `fdcc1f02-fc51-4226-8753-f668596af7f7` on `workiq.svc.cloud.microsoft`, Agent 365 Tools `05879165-0320-489e-b644-f72b33f3edf0` on `agent365.svc.cloud.microsoft` | Accepted.                                                            |
| GUID form of a blocked Microsoft API (list below)                                                                                                                                                                                                                                                  | Always rejected (`scope_audience_mismatch`), even if you confirm it. |
| GUID form of one of those two Microsoft MCP APIs on any other host                                                                                                                                                                                                                                 | Always rejected (`scope_audience_mismatch`), even if you confirm it. |
| Any other GUID form (an API the platform does not know)                                                                                                                                                                                                                                            | Accepted only after you confirm it (`scope_audience_unverified`).    |
| Anything else: a bare permission such as `Mail.Read` (Entra reads it as Microsoft Graph), a URL on another host, or a URL with a user name or port                                                                                                                                                 | Rejected (`scope_audience_mismatch`).                                |

**Blocked APIs.** Microsoft Graph, SharePoint Online, Exchange Online, Azure
Service Management, Azure AD Graph, Azure Key Vault, Azure Storage, Office 365
Management APIs, Microsoft Intune, Microsoft Defender for Endpoint
(WindowsDefenderATP), Skype for Business Online, Dynamics CRM, Azure SQL
Database, Log Analytics API, Skype and Teams Tenant Admin API, and Microsoft
Teams Services. These are high-impact Microsoft APIs, and a GUID form names no
host, so a confirmed one would let a token for them reach any MCP server. Only
the GUID form is blocked: a Microsoft MCP server whose audience is on its own
host (for example Dataverse at `<org>.crm.dynamics.com/api/mcp`) is connected
with a URL-form scope on that host, which is accepted as usual.

Azure DevOps and Power BI are deliberately not on this list. Their URL-form
audience lives on a host other than their MCP server, so their GUID form (for
example `00000009-0000-0000-c000-000000000000/.default` for Power BI) is the
only way to connect them; it is accepted after you confirm it, like any other
unknown API. That path is allowed by the audience policy but has not been
verified end to end against either server (see **Not supported** below).

**The server's own scope is required.** At least one scope must name the
server's API (a URL on its host, or a GUID form that is accepted or
confirmed). With sign-in scopes only, Entra issues a Microsoft Graph token,
so the install is rejected with `scope_audience_missing`. If the advertised
scopes break a rule, the Configure step shows a warning so you can fix the
list before installing.

**Confirming an unverified scope.** When a GUID scope names an API the
platform cannot tie to the server, the Confirm step lists those exact scopes
with the check box **I confirm these scopes belong to this server's own API**.
The confirmation covers exactly the strings listed: if you go back and change
the scopes, the wizard asks again. Through the API, send each one, as the
exact string, in `confirmedUnverifiedScopes`. control-api logs each
confirmation as the audit event `remote_install_unverified_scopes_confirmed`,
with the confirming admin and the scopes.

**Editing the McpServer later.** Writing the McpServer directly
(`PUT /api/v1/admin/mcp-servers/<name>` or `kubectl`) counts as confirming its
unverified GUID scopes: whoever can write the resource can already change its
server URL. It does not bypass the other rules. On every authorization,
callback, token use, and refresh, control-api checks the scopes again against
the current `spec.remote.baseUrl`. A blocked API, a known Microsoft MCP API's
GUID off its own host, a URL on another host, a bare permission, or a missing
server scope is refused with
`409 remote_oauth_spec_incoherent` (reason `scope_audience_mismatch`), and
existing grants stop being served until the resource is fixed.

> **Limit with unknown GUID scopes.** The GUID of an API the platform does not
> know is not tied to a host, so if only `spec.remote.baseUrl` changes, the
> platform cannot tell that the token now goes to a different server. Prefer the
> URL form (`api://<server-host>/...`) when the server accepts it. The Work IQ
> and Agent 365 Tools GUIDs are tied to their hosts, so that change is detected
> for them.

Ask for scopes of one API only. Entra issues each token for a single
resource, so mixing scopes of different APIs, or `.default` with specific
scopes, fails when the user connects.

**Not supported:**

- Verified support for MCP servers whose scope lives on a different host than
  the server, such as Power BI (`api.fabric.microsoft.com/v1/mcp/powerbi`, with
  scopes on `analysis.windows.net`) or Azure DevOps (`mcp.dev.azure.com`). The
  URL form is rejected; the GUID form is accepted after confirmation, but has
  not been verified end to end.
- National clouds (`login.microsoftonline.us`, `login.partner.microsoftonline.cn`),
  personal Microsoft accounts (`consumers`), and the v1 authority
  (`sts.windows.net`).
- A tenant given as a domain name, and certificate client credentials.

### Work IQ (recommended)

Server URL: `https://workiq.svc.cloud.microsoft/mcp`.

**Tenant prerequisites:**

- The Work IQ service principal. Create it once if your tenant does not have
  it: `az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7`.
- Microsoft's billing requirements in
  [Enable Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq):
  a pay-as-you-go billing plan backed by an Azure subscription, with the users
  who will connect assigned to that plan. Check that page for the current
  terms.

**App registration:** only the delegated permission `WorkIQAgent.Ask` of the
Work IQ API, with admin consent.

**Scopes.** Both forms are accepted without confirmation:

| Scope                                                  | Notes                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask`     | The form Microsoft's quickstarts use. **Try this one first**: it is tied to the host, so a later change of `spec.remote.baseUrl` is detected. |
| `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` | The form the server advertises, and the one the wizard prefills.                                                                              |

Replace the prefilled scope with the `api://` form, then install.
`offline_access` is added for you.

> **Pending end-to-end verification.** It is not yet confirmed which of the
> two forms Work IQ accepts. If the user connects but tool calls fail with
> `401`, delete the server and install it again with the GUID form.

### Agent 365 (legacy, not verified)

Microsoft states that the Agent 365 tooling servers are "only intended for
backward compatibility purposes and shouldn't be used in production
environments or new projects"
([Agent 365 tooling servers](https://learn.microsoft.com/microsoft-agent-365/tooling-servers-overview)).
Use [Work IQ](#work-iq-recommended) for new work.

> **Not verified.** This setup has not been run end to end. It is also not
> confirmed that Agent 365 accepts tokens issued to a regular app
> registration.

Server URL, for example Mail:
`https://agent365.svc.cloud.microsoft/agents/tenants/<tenant-id>/servers/mcp_MailTools`.

**Tenant prerequisites:**

- Agent 365 enabled in the tenant, and the server listed in the Microsoft 365
  admin center under **Agents > Tools**.
- The Agent 365 Tools service principal, created once per tenant by a Global
  Administrator with the `New-Agent365ToolsServicePrincipalProdPublic.ps1`
  script from the `microsoft/Agent365-devTools` repository.

**App registration:** one per Agent 365 server (Mail, Calendar, Teams, and so
on), each with only that server's delegated permission from the Agent 365
Tools app (`05879165-0320-489e-b644-f72b33f3edf0`), for example
`McpServers.Mail.All` for Mail. See
[Agent 365 tooling for developers](https://learn.microsoft.com/microsoft-agent-365/developer/tooling).

**Scopes.** control-api accepts these three forms without confirmation. Try
them in this order and keep the first one whose tool calls succeed:

1. The advertised scope, which the wizard prefills:
   `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant-id>/servers/mcp_MailTools/.default`.
   Every Agent 365 server and tenant shares this host, so the host check does
   not tell Mail from Calendar.
2. The form in Microsoft's manifest:
   `api://05879165-0320-489e-b644-f72b33f3edf0/McpServers.Mail.All`.
3. The bare GUID form: `05879165-0320-489e-b644-f72b33f3edf0/McpServers.Mail.All`.

Forms 2 and 3 are not interchangeable: depending on how a token is requested,
its audience can be the application ID URI or the application ID.

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
| CIMD authorization fails; the authorization server cannot fetch the client ID       | The callback origin is not public, or a custom gateway does not route `/api/v1/.well-known/evenfire-mcp-client` | Point `CONTROL_API_OAUTH_CALLBACK_BASE_URL` at the public origin, or forward that path to control-api      |
| **Detect** stops with an unreachable transport (`transport_unreachable` on install) | The URL is not the MCP endpoint                                                                                | Use the URL the wizard suggests, or the server's documented MCP path                                     |
| Marketplace OAuth form says the callback URL is not configured                      | `CONTROL_API_OAUTH_CALLBACK_BASE_URL` is unset on control-api                                                  | Set it, restart control-api, and reload the form                                                         |
| `503 integration_not_configured`                                                    | The client ID or secret Secret, or one of its keys, is missing                                                 | Create the Secret the hint names                                                                         |
| `403 context_membership_denied`                                                     | The user is not a member of the server's Context                                                               | Add the user to the Context                                                                              |
| Users must authorize again after a reinstall                                        | Grants are bound to the old McpServer UID                                                                      | Expected                                                                                                 |
| Connector shows **Missing Secret**                                                  | `SecretResolved=False`                                                                                         | Use **Set credentials** on the **Credentials** tab                                                       |
| Rotation restarted other connectors                                                 | They share the same `envSecret`                                                                                | Expected. Check `affectedConnectors`.                                                                    |
| **Detect** asks for a Microsoft Entra tenant ID                                     | The server signs in through Entra's multi-tenant authority (`tenant_required`)                                 | Enter the Directory (tenant) ID as a GUID                                                                |
| "Microsoft Entra ID did not recognize this tenant ID"                               | The GUID is not a tenant Entra knows                                                                           | Copy the Directory (tenant) ID from the Microsoft Entra admin center overview                            |
| Install returns `scope_audience_mismatch`                                           | A scope names another API: a blocked Microsoft API, a URL on another host, or a bare permission                | Use the server's own scope. See [Scopes and audience](#scopes-and-audience)                              |
| Install returns `scope_audience_missing`                                            | Only sign-in scopes (`openid`, `profile`, `email`, `offline_access`)                                           | Add the server's own scope                                                                               |
| Install asks to confirm scopes (`scope_audience_unverified`)                        | A GUID scope names an API the platform cannot tie to the server                                                | Confirm only if that API belongs to the server; otherwise change the scope                               |
| `409 oauth_client_id_in_use`                                                        | The app registration is already used by another server                                                         | Create a separate app registration for each server                                                       |
| Connect or token requests fail with `409 remote_oauth_spec_incoherent`              | The McpServer was edited and breaks a rule (reason `scope_audience_mismatch` or `as_profile_issuer_mismatch`)  | Fix `spec.oauth.scopes` or `spec.remote.baseUrl`, or reinstall the server                                |
| Install returns `409 mcpserver_crd_outdated`                                        | The cluster's McpServer CRD predates `spec.oauth.asProfile`, so Kubernetes dropped it                          | Apply the latest clerum-crds, then install again                                                         |

## Related

- [McpServer CRD: OAuth and status conditions](../crds/mcpserver.md#oauth-specoauth)
- [Add an MCP server](add-mcp-server.md)
- [Configure approvals](configure-approvals.md)
- [Control UI](../surfaces/control-ui.md) and [Desktop app](../surfaces/desktop-app.md)
