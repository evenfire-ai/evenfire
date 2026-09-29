# CodeQL `js/insufficient-password-hash` — disposition

This document records audited dispositions for [CodeQL](https://codeql.github.com/)
`js/insufficient-password-hash` findings. It supports Security-tab dismissals
(`dismissed_comment` + reason) per
[GitHub code scanning guidance](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts#dismissing-alerts).

## Why this query fires on OAuth code

The query flags a fast hash (`createHash('sha256')`, HMAC) whose input is tainted
by a value CodeQL classifies as a password. That classification is by
**identifier name**, not by value: variables and calls named `oauth`,
`catalogOAuth`, `oauthId`, `oauthClientId`, `state` or `OAUTH_*` are treated as
passwords. Any fingerprint, digest or HMAC computed over a structure that holds
OAuth configuration is therefore reported, even when no credential value is in
the hashed bytes.

Do not rename identifiers or change the hash to silence the query, and do not
exclude it in `.github/workflows/codeql.yml`: it still guards against a real
password hashed with SHA-256.

## Decision rule

| Hashed input                                                                                                                                                         | Disposition                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A content fingerprint (change detection, idempotency, readback) over configuration that holds only Secret **references** (`{ name, key }`), ids, endpoints or scopes | False positive — dismiss                                                       |
| An HMAC keyed by a server secret deriving an ephemeral value (PKCE `code_verifier`, signed state)                                                                    | False positive — dismiss                                                       |
| A **value** that is a password, client secret, token or API key, stored or compared later                                                                            | Real — fix with a slow KDF (scrypt/argon2/bcrypt) or stop persisting the value |

Before dismissing, confirm the hashed bytes cannot contain a credential value:
trace the object to where the credential is routed and check it is written
somewhere else (a Kubernetes Secret, the encrypted store), not into the hashed
structure.

## Dispositions

| Alert                                                                        | Location                                             | Evidence                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1109](https://github.com/evenfire-ai/evenfire/security/code-scanning/1109) | `control-api/src/oauth/pkce.ts:38`                   | `deriveCodeVerifier` = HMAC-SHA256(stateSecret, `pkce-verifier:` + state), an ephemeral RFC 7636 S256 verifier                                                                                                                                     |
| [#1204](https://github.com/evenfire-ai/evenfire/security/code-scanning/1204) | `control-api/test/oauth.state.test.ts:187`           | Test exercising the same keyed HMAC derivation                                                                                                                                                                                                     |
| [#1205](https://github.com/evenfire-ai/evenfire/security/code-scanning/1205) | `host-context-controller/src/hostReconciler.ts:1243` | `shortHash` = SHA-256 fingerprint of a Host's scope/binding config for change detection                                                                                                                                                            |
| [#1554](https://github.com/evenfire-ai/evenfire/security/code-scanning/1554) | `control-api/src/services/registryMutation.ts:53`    | `registrySpecDigest` = SHA-256 fingerprint of the McpServer spec (annotation `clerum.io/registry-spec-sha256`). `spec.oauth` carries `clientIdRef`/`clientSecretRef` only; the managed client credentials go to the `<server>-oauth-client` Secret |

## Guarding test

`control-api/test/routes.registryInstall.oauthSpecDigest.test.ts` pins the
invariant behind #1554: for the baked and generic-confidential install lanes,
the persisted digest annotation equals `registrySpecDigest(spec)`, the managed
Secret holds the client credentials, and `canonicalRegistryJson(spec)` contains
neither the client id nor the client secret value. Inlining the client secret
into `spec.oauth` in either lane fails both cases.

## Dismissal template (Security tab / API)

The API limits `dismissed_comment` to 280 characters.

```
Not a password hash: <what the digest/HMAC is for>. <why the hashed bytes hold no credential value>. See docs/how-to/codeql-js-insufficient-password-hash.md.
```

## Re-open triggers

Re-audit when:

- A dismissed sink line is edited: the alert fingerprint changes and a new alert opens
- An install or update path writes a credential value into `spec.oauth` or any other hashed spec
- A new `createHash` / `createHmac` call takes OAuth-derived input
