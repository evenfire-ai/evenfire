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
