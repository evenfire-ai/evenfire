# style-rules

Lightweight, repo-local enforcement for the frontend style conventions
documented in the [shared](../../docs/agents/frontend-style-rules.md) and
[Desktop renderer](../../docs/agents/desktop-ui-rules.md) guidance plus
[`desktop-app/ui/docs/STYLE_STANDARDIZATION.md`](../../desktop-app/ui/docs/STYLE_STANDARDIZATION.md).

This is **not** Stylelint or ESLint. It is a small Node script — same shape
as `scripts/prettier/run-on-staged.mjs` — chosen because:

- The rules are narrow and project-specific (e.g. "block new component-level
  CSS files except this allowlist").
- No new dependencies are added to the repo.
- The full rule set fits in ~200 lines of readable JS, so any agent or
  human can audit and extend it without learning a plugin ecosystem.

## What's enforced today

Scope: `desktop-app/ui/**` plus the shared table-system boundary for production
source under `control-ui/**` and `profile-ui/**`.

| Rule ID                           | Severity | What it catches                                                                                     |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `da-no-hex-in-css`                | error    | `color: #abc` / `border: 1px solid #fff` outside `tokens.css` and the 3 legacy files.               |
| `da-no-raw-font-size`             | error\*  | `font-size: 14px` / `font-size: 1rem` outside `tokens.css`. Use `var(--font-size-*)`.               |
| `da-no-new-component-css`         | error    | New `.css` files under `desktop-app/ui/src/` other than the 5 allowlisted ones.                     |
| `da-no-hover-motion`              | error    | Hover states that move, scale, or filter controls. Use background/border/text/shadow token changes. |
| `da-no-hex-in-tsx`                | warn     | Hex literals in TS/TSX strings. Reviewer judgment for genuinely dynamic cases.                      |
| `da-no-static-inline-style`       | warn     | JSX `style={{...}}` not containing `--da-grid-cols` or whitelisted runtime values.                  |
| `web-no-app-local-table`          | error    | Raw production `<table>` shells in Control UI or Profile UI instead of the shared table system.     |
| `web-no-app-local-table-viewport` | error    | Direct application authorship of `eft-table-viewport` instead of shared `TableViewport`.            |
| `web-no-retired-table-pattern`    | error    | Production references to retired app-local table, row-action, tab, or expansion families.           |

\*`da-no-raw-font-size` is downgraded to `warn` for the 3 legacy CSS files
to allow boy-scout migration without forcing one big-bang cleanup.

The allowed-CSS allowlist (`ALLOWED_DESKTOP_CSS` in `rules.mjs`):

- `desktop-app/ui/src/styles.css`
- `desktop-app/ui/src/styles/tokens.css`
- `desktop-app/ui/src/components/ChatListPanel.css` (legacy)
- `desktop-app/ui/src/components/ProgressStepper.css` (legacy)
- `desktop-app/ui/src/components/ArtifactsBadge.css` (legacy)

## Commands

```sh
# Pre-commit (called from .githooks/pre-commit)
npm run style-rules:staged

# Full repo, errors only
npm run style-rules

# Full repo, treat warnings as errors (CI strict mode)
npm run style-rules -- --strict
```

## Extending

To add a rule, edit `rules.mjs` and append to the `rules` array. Each rule
has the shape:

```js
{
  id: 'unique-id',
  severity: 'error' | 'warn',
  description: 'one-line summary',
  applies(file) { /* return true if the rule applies to this path */ },
  check({ file, content, lines }) {
    return [{ line, message, severityOverride? }]
  },
}
```

Control/Profile checks deliberately exclude tests, E2E fixtures, mocks, and
the shared package implementation itself. They enforce the documented
application boundary without banning semantic table markup inside the shared
system or legitimate non-table disclosure controls.

Rule-unit tests use synthetic source fixtures. Repository-wide conformance is
covered separately by `npm run style-rules` and its strict variant, so deleting
or renaming valid production screens cannot stale a manually maintained test
manifest.

## Why not Stylelint?

Considered and skipped intentionally. Notes:

- Stylelint covers CSS rules but not the TSX-side checks (inline styles,
  hex literals in strings, blocking new sibling `.css` files). We'd still
  need a second tool — easier to keep it in one place.
- The repo's existing convention is custom Node scripts in `scripts/`.
  Adding a Stylelint dependency + plugin config + ignore file would diverge
  from that convention without enough payoff for a handful of rules.
- If the rule count grows past ~15 or auto-fix becomes a hard requirement,
  reconsider.
