# Desktop app link contract

Evenfire app links identify an accessible Sandbox UI app and may restore a client-side route:

```text
evenfire://app/<recipe-namespace>/<recipe-name>?path=/tasks/42&team=<team-id>
```

The optional `path` is an SPA pathname. The desktop first loads the recipe's configured default
server route, then applies `path` with the browser history API after the app is ready. A shared link
must not depend on the server serving that nested pathname directly.

Queries and fragments are intentionally excluded because they can contain OAuth codes, access
tokens, or other ephemeral browser state. Apps that need durable shared state should encode a
non-sensitive identifier in the pathname and fetch the corresponding data after opening.

Browser handoff links require a root-mounted HTTP(S) Profile UI and use `/open/apps/...`. A Profile
UI deployed below a path prefix is not compatible with this contract.
