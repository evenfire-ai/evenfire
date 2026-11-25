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

Wire-contract changes to app links must be additive by default:

- Consumers must tolerate unknown query parameters. This rule does not apply to the Desktop
  sign-in links below, which are parsed strictly.
- Existing hostnames and parameter names must not be renamed or removed without a migration plan.
- New query parameters must remain optional while older supported desktop versions exist.
- Producers must keep emitting the existing `app` hostname plus `path` and `team` parameter names
  for the supported migration window.
- Any breaking wire change requires a separate versioning design before it ships.

New clients represent `path` as decoded canonical route text on the wire and percent-encode each
segment only when navigating the embedded browser. Desktop versions released before that navigation
boundary was added may not open a literal-percent segment, such as `literal%percent`, from a link
created by a newer producer. Deployments with mixed client versions should avoid sharing
literal-percent routes until supported desktops have been updated. Changing this representation to
support older clients would be a breaking wire change and requires the separate versioning design
described above.

## Desktop sign-in links

Desktop signs in through the browser. It opens a Profile UI page, and Profile UI ends the sign-in
with an `evenfire://desktop-login` link back to Desktop. This package holds the one builder and the
one parser for each of these values. Profile UI and Desktop must use them rather than build or parse
these values by hand.

Unlike the app links' tolerate-unknown rule above, these values are parsed strictly. An unknown
value, or an unknown, extra or duplicate parameter, makes the whole input invalid. The only
forward-compatible case is an unknown refusal reason, which reads as `failed`.

Challenge, state and code are 43 base64url characters (`/^[A-Za-z0-9_-]{43}$/`).

**`signInUrl`.** The page Desktop opens, as the server advertises it in its sign-in methods.
`parseDesktopLoginSignInUrl` accepts an `https:` URL of at most 2048 characters, with no user info,
no query and no fragment, whose pathname is exactly `/desktop-login` (`DESKTOP_LOGIN_PATH`). The
pathname comparison is case-sensitive, so a trailing slash or `/Desktop-Login` is refused. A bare
`?` or `#` is refused too. The parser returns the URL's origin plus `/desktop-login`.

**The page URL** carries the challenge and state in the fragment, never in the query, so they never
reach a server log or a `Referer` header:

```text
https://profile.example.test/desktop-login#challenge=<challenge>&state=<state>
```

`parseDesktopLoginFragment` takes the hash with or without its leading `#`. It needs exactly one
`challenge` and one `state`, and no other key. When the fragment is invalid but its one `state` is
well formed, it returns `{ valid: false, state }`, so the page can still tell Desktop the sign-in
cannot go on. Otherwise the state is `null`.

**The result links** (host `DESKTOP_LOGIN_DEEP_LINK_HOST`):

```text
evenfire://desktop-login?state=<state>&code=<code>&environment=<environment>
evenfire://desktop-login?state=<state>&error=<error>[&reason=<reason>]
```

- `environment` is the edge's public base URL: `http:` or `https:`, at most 2048 characters, with no
  user info, query or fragment. It is returned exactly as built, with no trailing slash added.
- `error` is one of `DESKTOP_LOGIN_ERRORS`: `refused`, `cancelled`, `unavailable` or `failed`.
- `reason` appears only with `refused`, and is one of `DESKTOP_LOGIN_REFUSAL_REASONS`.

**Refusal reasons.** An unlisted or missing refusal reason means `failed`, on both sides of the link:

- `buildDesktopLoginErrorLink` writes `error=failed`, with no reason, for `refused` with an unlisted
  or missing reason. It does not write a reason for any other error.
- `parseDesktopLoginLink` reads `error=refused` with an unlisted or missing reason as
  `{ kind: 'error', state, error: 'failed' }`.

The builders throw on a bad state, code, environment or error. `parseDesktopLoginLink` returns
`null` for:

- another scheme, host or port, or a path;
- a fragment;
- an unknown `error` value;
- an unknown, extra or duplicate parameter;
- a `reason` on any error other than `refused`;
- a link with both `code` and `error`.
