# Style Standardization — desktop-app/ui

This document is the authoritative reference for **how a page is built in desktop-app/ui** after the layout/token consolidation refactor. It complements the cross-app rules in [`../../../docs/agents/frontend-style-rules.md`](../../../docs/agents/frontend-style-rules.md) — read that first; this doc adds desktop-app-specific patterns.

When in doubt, mimic an existing post-refactor page (`ContextsPage`, `WorkflowsPage`, `TeamsPage`, `McpServersPage`) before inventing.

## 1. Page shell

Every top-level route renders the same skeleton. The shell is **className-driven** — there is intentionally no `<PageShell>` / `<PageHeader>` wrapper component. Use the classes directly.

```tsx
<section className="page">
  <div className="page-header">
    <h2>Plugins</h2>
    <p className="muted">Short description, one sentence.</p>
  </div>

  {error && (
    <section className="page-card" role="alert">
      …
    </section>
  )}

  <div className="page-layout">
    <section className="page-card [page-specific-modifier]">
      {/* loading | empty | content */}
    </section>
  </div>
</section>
```

Rules:

- The page-level heading is `<h2>` (the `<h1>` is implicit from the sidebar). Subsection headings inside `.page-card__header` are `<h3>`.
- Description goes in `<p className="muted">`. Keep it to one sentence.
- `.page-layout` exists to host one or more `.page-card` siblings — it sets the gap between cards. Wrap content in it even when there is a single card so future additions don't reflow.
- Loading and empty states reuse the same `<EmptyState>` primitive inside a `.page-card`. Don't invent loading skeletons at the page level.
- Errors render as their own `.page-card` with `role="alert"` above the content layout. Never overlay errors on top of cards.
- Page-specific styling (e.g. `workflows-list-card`, `contexts-board-card`) is added as a second class on `.page-card`, not by replacing it. Exception: when the card contains _only_ a `da-grid` (no header, no toolbar), the modifier should override the page-card frame to `none` so only the grid's own frame is visible — see §3 "Table frame ownership".

Tokens consumed by the shell: `--space-2-5`, `--space-3`, `--radius-md`, `--surface-strong`, `--shadow-soft`, `--font-size-{lg,2xl,3xl}`, `--text`, `--text-muted`, `--edge-rgb`, `--accent-rgb`. Do not redefine these locally.

## 2. Tabs

Use `.page-tabs` + `.page-tab` with the `active` modifier:

```tsx
<div className="page-tabs">
  <button className={`page-tab${tab === 'a' ? ' active' : ''}`} onClick={() => setTab('a')}>
    A
  </button>
  <button className={`page-tab${tab === 'b' ? ' active' : ''}`} onClick={() => setTab('b')}>
    B
  </button>
</div>
```

The legacy aliases `.agents-fleet-tabs`, `.context-tabs`, `.team-tabs` (and their `-tab` element classes) share the same styles via grouped selectors. **New code uses `.page-tabs` / `.page-tab` only** — don't add new domain-specific tab class families.

## 3. DataGrid (`.da-grid`)

The DataGrid is the canonical pattern for any tabular listing. It is a CSS-grid-driven primitive built from BEM classes.

```tsx
import { SCOPED_RESOURCE_4COL } from '../lib/gridTemplates'

;<div className="da-grid" style={{ '--da-grid-cols': SCOPED_RESOURCE_4COL }}>
  <div className="da-grid__head">
    <span className="da-grid__col-header">Name</span>
    <span className="da-grid__col-header da-grid__col-header--center">Scope</span>
  </div>
  <div className="da-grid__body">
    {rows.map(row => (
      <button
        key={row.id}
        type="button"
        className={`da-grid__row da-grid__row--clickable${
          row.id === selectedId ? ' da-grid__row--selected' : ''
        }`}
        onClick={() => onSelect(row.id)}
      >
        <span>{row.name}</span>
        <span className="da-grid__cell--center">{row.scope}</span>
      </button>
    ))}
  </div>
</div>
```

Available modifiers:

- Rows — `--compact` (denser row height), `--clickable` (cursor + hover state, required when the row is a `<button>`), `--selected` (highlighted state).
- Column headers and cells — `--center`, `--right` (alignment).

Column widths are set via the CSS variable `--da-grid-cols` inline. **This is the only acceptable inline-style use in pages.** Two rules apply:

1. If the column template is shared across two or more pages, define it as a named constant in `src/lib/gridTemplates.ts` and import it. Existing constants: `SCOPED_RESOURCE_4COL`, `MEMBERS_3COL`.
2. If the template is unique to one page, leave it as a literal inline next to the JSX it describes — colocation beats premature extraction.

Never add a new tabular-listing class family in parallel to `.da-grid`. Extend `da-grid` with new modifiers if needed.

### Table frame ownership

**Every table/grid always owns its own frame** — regardless of what surrounds it.

`da-grid` always renders with `border: 1px solid var(--table-frame-border)`, `border-radius: var(--table-radius)`, and `background: var(--table-frame-bg)`. Never override these to `none` / `transparent` in a contextual selector. The same applies to `da-table__scroll` and `mcp-health-section`.

When a grid lives inside a `page-card` that also has a header or toolbar, two visual layers are intentional:

```
page-card            ← widget/panel frame  (stronger border, shadow — from page-card tokens)
  └─ header/toolbar
  └─ da-grid         ← data frame  (--table-frame-* tokens, no shadow)
```

This "panel containing a table" hierarchy is correct. Do not flatten it by removing either frame.

For pages where `da-grid` is the _only_ content of the card (no header, no toolbar), the `page-card` wrapper is made frameless via its page-specific modifier so only the grid frame is visible:

```css
/* page-card that hosts only a da-grid — grid provides the frame */
.my-list-card {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
}
```

Existing modifiers that follow this pattern: `.contexts-board-card`, `.workflows-list-card`.

`da-table__scroll` is the combined frame + scroll wrapper for `da-table` — no separate wrapper is needed.

### Column header design language

All table headers — `.da-grid__head`, `.da-table__col-header`, and any future tabular header — share the same visual language:

| Property       | Token                                                       |
| -------------- | ----------------------------------------------------------- |
| Font size      | `var(--table-header-font-size)` (`= --font-size-xs`, 11 px) |
| Font weight    | `var(--font-weight-bold)`                                   |
| Letter spacing | `var(--letter-spacing-caps)`                                |
| Text transform | `uppercase`                                                 |
| Color          | `var(--table-header-color)`                                 |
| Background     | `var(--table-header-bg)`                                    |

Never hardcode `700`, `0.06em`, `11px`, or `var(--font-size-xs)` / `var(--text-dim)` on a header — use the semantic table tokens above. Any custom header component (e.g. `McpServerHealthTable`) must follow the same token set.

## 4. Common Controls — Use Them

Imports come from `@components/Common`. The exported set is fixed:

| Primitive      | Key API                                                          |
| -------------- | ---------------------------------------------------------------- |
| `Button`       | `variant`, `color`, `size`, `block`, `loading`, `align`          |
| `TextInput`    | `dense` + native `<input>` props                                 |
| `SelectInput`  | `dense` + native `<select>` props (children = `<option>`s)       |
| `Field`        | `label`, `hint`, `htmlFor`, `labelClassName`, `wrapperClassName` |
| `Badge`        | `tone: 'neutral' \| 'accent' \| 'success'`                       |
| `StatusBanner` | `text`, `tone`, `leadingIcon?`                                   |
| `EmptyState`   | `title`, `body`                                                  |
| `DetailRow`    | `label`, `value`                                                 |
| `ToastStack`   | `items: ToastMessage[]`                                          |

Do not recreate equivalents inline. If a real new common control is needed, add it under `src/components/Common/<Component>/index.tsx` with colocated `types.ts`, then re-export it from `src/components/Common/index.ts` — not as a one-off in a page file.

### Feedback Placement

Use the app toast stack for success feedback after a completed user action, such as saving settings, triggering workflows, or approving requests. Do not render inline green success banners inside page cards or forms for transient confirmations. Inline `StatusBanner` is reserved for persistent page state, warnings, errors, and informational messages that must remain visible while the user decides what to do next.

## 5. Where pages live

- Top-level pages: `src/pages/*.tsx` (flat). `ContextsPage`, `WorkflowsPage`, `TeamsPage`, `McpServersPage`, `ContextDetailsPage`, `TeamDetailsPage`, `AgentsPage`.
- Auth/error pages with their own subtree: `src/pages/<Name>Page/index.tsx` (folder-based). `AuthPage`, `UnavailablePage`.
- Tests: `src/pages/__tests__/<Name>Page.test.tsx`.

When adding a new page, prefer flat `<Name>Page.tsx` unless the page already needs adjacent files (constants, types, sub-components).

## 6. CSS — what to extend, what to leave alone

- All shared layout/component classes live in `src/styles.css`. Add new shared rules at the end of the relevant section.
- Tokens live in `src/styles/tokens.css`. Reach for an existing token first; promote a new value only when it is used in three or more places.
- Three legacy component-level stylesheets exist and **must not be extended**: `src/components/ChatListPanel.css`, `src/components/ProgressStepper.css`, `src/components/ArtifactsBadge.css`. They predate the refactor. When a feature touches one of these surfaces, migrate the rules into `styles.css` (boy-scout) — don't add new rules to the legacy file.

## 7. Enforcement

A subset of the rules above is enforced automatically by a small Node
checker under `scripts/style-rules/` (mirrors `scripts/prettier/run-on-staged.mjs`).
It runs on every commit via `.githooks/pre-commit` and can be invoked manually:

```sh
npm run style-rules               # full repo, errors only
npm run style-rules -- --strict   # treat warnings as errors (CI)
npm run style-rules:staged        # what pre-commit runs
```

What it catches today (errors block the commit):

- `da-no-hex-in-css` — hex literal in any CSS file outside `tokens.css` and the 3 legacy files.
- `da-no-raw-font-size` — `font-size: 13px` / `1rem` outside `tokens.css`. Use one of `var(--font-size-{2xs|xs|sm|md|lg|xl|2xl|3xl|4xl})`.
- `da-no-new-component-css` — new `.css` files under `src/` other than the 5 allowlisted ones.

Plus two warn-level checks (listed but don't block):

- `da-no-hex-in-tsx` — hex literal in `.ts/.tsx` strings.
- `da-no-static-inline-style` — JSX `style={{…}}` not containing `--da-grid-cols` or a documented runtime value.

### Adding a runtime-value escape hatch

`da-no-static-inline-style` recognizes a small whitelist of substrings that
identify legitimate runtime-driven styles (popup positioning, computed
z-index, etc.). The current list lives in `INLINE_STYLE_DYNAMIC_HINTS` in
`scripts/style-rules/rules.mjs`.

If you add a new genuinely-dynamic inline style (e.g. a new menu anchor
position computed from a ref), the warning will fire. Resolve it by:

1. Confirming the style truly cannot live in `src/styles.css` — most cases
   can. A `top`/`left` that depends on a computed `getBoundingClientRect()`
   is fine inline; a static `padding: 8px` is not.
2. Picking a clearly-named variable for the dynamic value (e.g.
   `menuAnchorPosition`, not `pos`) and using it inside the style block.
3. Adding that variable name as a string entry in
   `INLINE_STYLE_DYNAMIC_HINTS`. One line.
4. Mentioning the new hint in this section so future contributors don't
   wonder where it came from.

Currently whitelisted hints: `--da-grid-cols`, `fleetMenuPosition`,
`sessionMenuPosition`, `zIndex: visible.length`, `--seg-width` (data-driven
stacked-bar segment width in the context-window breakdown popover).

### Extending coverage

To extend rules or add coverage to control-ui / profile-ui, edit
`scripts/style-rules/rules.mjs`. The checker has no external dependencies
and the full rule set is ~200 lines of readable JS — see
`scripts/style-rules/README.md`.

## 8. Anti-patterns to avoid

- New CSS files at component level (`.module.css` or sibling `.css` to a `.tsx`). The three legacy ones are the exception, not a precedent.
- Re-declaring page shell layout inside a page (`<div style={{ display: 'grid', gap: '...' }}>` instead of `.page` / `.page-layout`).
- Adding a new tab class family per domain. Use `.page-tabs` / `.page-tab.active`.
- Adding a parallel grid/table class family. Extend `.da-grid` modifiers.
- Hex colors literal in TS/TSX. The one acceptable case is user-controlled dynamic state (e.g. annotation color picker initial value).
- Inline styles other than `--da-grid-cols`. If you find yourself reaching for one, the right move is usually a class on the global stylesheet or a new token.
- **Removing a table's own frame via contextual overrides.** Never write `.some-context .da-grid { border: none; background: transparent }` — every table always owns its own frame regardless of what surrounds it. See §3 "Table frame ownership".
