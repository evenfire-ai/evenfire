# Control UI coding rules

These provider-neutral rules apply only to `control-ui/**`. Combine them with
[`frontend-style-rules.md`](./frontend-style-rules.md). They do not apply to
`profile-ui`, Desktop, backend services, deployment manifests, or shared docs.

## Styling and components

- `app/globals.css` owns Control UI token declarations and shared CSS
  classes/layout. Consume colors, spacing, radii, shadows, motion, and z-index
  through its CSS variables instead of hardcoding tokenized values.
- Use the `cu-` prefix for shared utility classes.
- Reusable components live under `components/` in folders with `index.tsx` and
  colocated support such as `types.ts`.
- Reusable configuration constants live under `app/constants/`.
- Reuse the primitives exported by `components/ui/index.tsx`: `Button`,
  `Field`, `TextInput`, `SelectInput`, `TextAreaInput`, `CheckboxField`, and
  `FormSection`.

## Typography and tokens

`app/globals.css` declares the full scale. Never write a raw `font-size` in CSS
or a `fontSize` in TSX; use the token.

| Token                | Size | Use for                             |
| -------------------- | ---- | ----------------------------------- |
| `--cu-font-size-2xs` | 11px | uppercase eyebrows, table `th`      |
| `--cu-font-size-xs`  | 12px | field hints, panel subtitles, chips |
| `--cu-font-size-sm`  | 13px | tabs, small buttons, dense body     |
| `--cu-font-size-md`  | 14px | default body text, table cells      |
| `--cu-font-size-lg`  | 15px | panel header, emphasized row title  |
| `--cu-font-size-xl`  | 16px | card and section title              |
| `--cu-font-size-2xl` | 18px | page subhead                        |
| `--cu-font-size-3xl` | 22px | page hero                           |
| `--cu-font-size-4xl` | 28px | auth hero only                      |

Weights are `--cu-font-weight-regular` (400), `--cu-font-weight-medium` (500),
`--cu-font-weight-semibold` (600), and `--cu-font-weight-bold` (700). Line
heights are `--cu-line-height-tight` (1.2) for headings,
`--cu-line-height-normal` (1.45) for body and hints, and
`--cu-line-height-relaxed` (1.5) for the page body default. Monospaced text uses
`--cu-font-mono`; do not write out a monospace stack by hand.

Do not add a font-size token outside this scale. The scale is intentionally
narrow, and a value that does not fit is a design decision to raise, not a token
to add.

**This scale intentionally differs from Desktop's.** `--cu-font-size-md` is
**14px** here; `--font-size-md` in `desktop-app/ui/src/styles/tokens.css` is
**13px**. Desktop's scale has no 14px or 16px step, and Control UI relies on
both. The prefixes differ (`--cu-` versus bare), the values differ, and that is
deliberate. Do not "align" them without an explicit design decision.

Spacing uses `--cu-space-0` (2px), `--cu-space-05` (4px), then `--cu-space-1`
through `--cu-space-7` (0.35rem, 8px, 12px, 16px, 20px, 24px, 32px). Radii are
`--cu-radius-xs` (4px), `--cu-radius-sm` (8px), `--cu-radius` (12px), and
`--cu-radius-pill`. Transitions use `--cu-motion-fast` or `--cu-motion-base`.
Prefer an existing token over a raw `rem` or `px` value.

Every `--cu-*` name a rule references must be declared in `app/globals.css`.
`var(--cu-missing)` with no fallback is invalid at computed-value time, so the
whole declaration is silently dropped. `var(--cu-missing, something)` does use
the fallback, but it hides the fact that the token was never defined and locks
the rule to whatever the fallback happens to be. Declare the token instead of
leaning on either behaviour.

## Tables and row actions

- Use `@clerum/frontend-table-system` directly or the thin Control UI adapters
  `TablePanelHeader`, `TableHeaderRow`, `SectionSearchInput`, and
  `RowActionsMenu`. Those adapters preserve Control UI labels/routes/classes;
  they do not own a second semantic table implementation.
- Column headers use `--cu-font-size-2xs`, semibold, uppercase, `0.05em`
  letter-spacing. Shared sortable headers own the button, indicator, and
  `aria-sort` semantics.
- Right-align numeric columns and set `font-variant-numeric: tabular-nums` so
  digits line up.
- Keep the table element and its header row mounted through loading, empty, and
  error states. Only the body changes. An empty result renders a full-width row,
  not an unmounted table.
- Ordinary resource rows use `TableRow` (or equivalent shared keyboard
  behavior) for detail navigation. Stop propagation inside the actions cell so
  opening a menu never navigates the row.
- Render all per-record operations with `RowActionsMenu`; do not restore inline
  edit/delete icon clusters or the removed `RowActions` overflow heuristic.
- Do not restore `cu-expandable-table`, expandable record rows, or inline detail
  `<tr>` sections. Move record details to the canonical route; use a modal only
  for a bounded action that must complete without leaving the list.

## Routing

- Sidebar destinations and shareable tab-like sections use canonical Next App
  Router paths and child route segments. Do not use `?tab=...`, `profileTab`,
  `localStorage`, or component-only state as the section-routing source.
- Query parameters remain valid for transient actions, form modes, filters,
  search, and external callback state; they are not primary section navigation.
- Import internal destinations and dynamic/query builders from
  `app/constants/routes.ts`. Never inline Control UI paths in links, redirects,
  router actions, form actions, sidebar items, or tabs. Pass raw dynamic
  identifiers to the route builder.

## Page patterns

- Use `TablePanelHeader` and `TableHeaderRow` for route tables and sections;
  both delegate their semantic behavior to the shared table package.
- Keep the section icon, title, subtitle, search, refresh, and CTAs visible
  while initial loading, empty, and error states render in the content area.
  Disable header CTAs during initial loading, and let only the content pane
  scroll when rows overflow.
- In `TablePanelHeader`, pass page-action buttons through `actions`, the refresh
  control through `refreshAction`, and the search input through `search`. The
  adapter renders that semantic and focus order, keeps those controls on one
  toolbar line whenever their combined minimum widths fit, and preserves their
  order when a genuinely crowded toolbar must wrap.
- Use `CreatePageHeader` plus `cu-create-panel`, `cu-create-content`, and
  `cu-form-grid` for full-screen create/install pages. Put Cancel in a ghost
  button and Submit in a primary button inside `cu-create-actions`. Use `<h2>`
  for the create-page heading.
- Wrap auth-gated pages in `<AuthGate>`.
- Reserve `cu-modal-panel` for overlay/dialog contexts. Modal panel headings use
  `<h3>`; table panel labels are not headings.
