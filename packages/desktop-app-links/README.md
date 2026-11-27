# Desktop app link contract

Evenfire app links identify an accessible Sandbox UI app and may restore a client-side route:

```text
evenfire://app/<recipe-namespace>/<recipe-name>?path=/tasks/42&team=<team-id>
```

The optional `path` is an SPA pathname. The desktop first loads the recipe's configured default
server route, then applies `path` with the browser history API after the app is ready. A shared link
must not depend on the server serving that nested pathname directly.

Safe route pathnames are normalized to one canonical logical representation. Percent-encoded
equivalents may collapse to that representation, so the contract provides semantic, idempotent
share/open/share round trips rather than byte-for-byte preservation of the original encoded input.
Traversal segments, encoded separators, query and fragment data, and control characters remain
rejected.

Queries and fragments are intentionally excluded because they can contain OAuth codes, access
tokens, or other ephemeral browser state. Apps that need durable shared state should encode a
non-sensitive identifier in the pathname and fetch the corresponding data after opening.

Browser handoff links require a root-mounted HTTP(S) Profile UI and use `/open/apps/...`. A Profile
UI deployed below a path prefix is not compatible with this contract.

## Desktop environment and setup handoffs

Profile UI hands two more links to the installed desktop:

```text
evenfire://desktop-environment?externalRestApiBaseUrl=<url>&tenantName=<name>
evenfire://desktop-setup?email=<email>&authorizationToken=<token>
```

| Export                                                                    | Purpose                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP_ENVIRONMENT_DEEP_LINK_HOST`, `DESKTOP_SETUP_DEEP_LINK_HOST`      | Hostnames of the two links.                                                                                                                                                                                                                  |
| `buildDesktopEnvironmentDeepLink({ externalRestApiBaseUrl, tenantName })` | Builds the environment link. Encodes with `URLSearchParams`, so a space becomes `+`. Emits exactly those two keys in that order.                                                                                                             |
| `parseDesktopEnvironmentDeepLink(rawUrl)`                                 | Returns `{ externalRestApiBaseUrl, appName }`, or `null` when the URL does not parse, the protocol or host differs, or `externalRestApiBaseUrl` is empty. `appName` comes from `tenantName`, falling back to the legacy `appName` parameter. |
| `buildDesktopSetupDeepLink({ email, authorizationToken })`                | Builds the setup link. Encodes each value with `encodeURIComponent`, so a space becomes `%20`. Throws `URIError` on a lone surrogate.                                                                                                        |
| `parseDesktopSetupDeepLink(rawUrl)`                                       | Returns `{ email, authorizationToken }`, or `null` when the URL does not parse, the protocol or host differs, or either value is empty.                                                                                                      |

The builders do not validate or normalize their input; callers gate and default it. The parsers
compare the host case-insensitively and read each parameter with `URLSearchParams.get`, so the
first occurrence of a repeated parameter wins.

## Cross-version compatibility

Profile UI and installed desktop clients can run different versions. A browser may generate a link
with a newer Profile UI while the operating system opens an older installed desktop parser.

Wire-contract changes must be additive by default:

- Consumers must tolerate unknown query parameters.
- Existing hostnames and parameter names must not be renamed or removed without a migration plan.
- New query parameters must remain optional while older supported desktop versions exist.
- Producers must keep emitting the existing `app` hostname plus `path` and `team` parameter names
  for the supported migration window.
- Any breaking wire change requires a separate versioning design before it ships.

The desktop-environment and desktop-setup links are frozen as follows for the same reason:

- The parser keeps accepting the legacy `appName` parameter as an alias for `tenantName`.
- When both are present, a non-empty `tenantName` wins over `appName`; an empty `tenantName`
  falls back to `appName`.
- The parsers ignore a port, userinfo, a path, a fragment, and unknown query parameters.
- Each host keeps its encoding: `URLSearchParams` (`+` for a space) for `desktop-environment` and
  `encodeURIComponent` (`%20` for a space) for `desktop-setup`.

New clients represent `path` as decoded canonical route text on the wire and percent-encode each
segment only when navigating the embedded browser. Desktop versions released before that navigation
boundary was added may not open a literal-percent segment, such as `literal%percent`, from a link
created by a newer producer. Deployments with mixed client versions should avoid sharing
literal-percent routes until supported desktops have been updated. Changing this representation to
support older clients would be a breaking wire change and requires the separate versioning design
described above.
