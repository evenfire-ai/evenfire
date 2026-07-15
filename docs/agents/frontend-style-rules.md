# Frontend style rules (control-ui, desktop-app/ui, profile-ui)

These rules apply only when editing files under `control-ui/**`, `desktop-app/ui/**`, and `profile-ui/**`.

## Scope

- Preserve the established interaction behavior first.
- Keep disabled, loading, hover, focus, validation, and empty states working before simplifying styles.
- Favor consolidation when two variants are effectively the same, but do not flatten intentionally different behavior.

## Rules

1. Types in dedicated files

- Do not declare exported or reusable `type` / `interface` definitions inside component implementation files.
- Keep reusable component and page types in a sibling `types.ts` file, or `*.types.ts` when the local structure needs it.
- Implementation files must import those types instead of redefining them inline.

2. Color tokens via project-global CSS variables

- Do not hardcode color values in component styles.
- Each project defines shared color tokens in its global stylesheet:
  - `control-ui` → `app/globals.css`
  - `desktop-app/ui` → `src/styles/tokens.css`
  - `profile-ui` → `app/globals.css`
- Consume colors through `var(--token-name)` in components and shared styles.

3. Spacing, size, and motion tokens first

- Prefer existing CSS variables for spacing, radii, font sizes, shadows, and transitions.
- When no existing token fits, add a new scoped variable in the closest relevant stylesheet.
- Only promote a token to the global stylesheet when it is clearly shared across multiple modules.
- Use project-defined spacing scales (e.g., `--cu-space-*` in control-ui/profile-ui) instead of raw rem values.

**Typography scale** — currently defined in `desktop-app/ui/src/styles/tokens.css` and consumed throughout desktop-app's page shell, tabs, and primitives. control-ui/profile-ui will adopt the same scale when their typography is consolidated; until then, follow the inline values already in their stylesheets.

The authoritative values live in `tokens.css`; the table below mirrors them and must be kept in sync.

Body sizes:

- `--font-size-2xs` (10px) — micro: timestamps, dot-labels
- `--font-size-xs` (11px) — column headers, metadata
- `--font-size-sm` (12px) — secondary body, hints
- `--font-size-md` (13px, default) — default body, table cells
- `--font-size-lg` (15px) — emphasized body, row title
- `--font-size-xl` (18px) — card title, section title

Heading sizes:

- `--font-size-2xl` (22px) — page subhead
- `--font-size-3xl` (28px) — page hero
- `--font-size-4xl` (36px) — auth hero only

Font weights — `--font-weight-regular` (400), `--font-weight-medium` (500), `--font-weight-semibold` (600), `--font-weight-bold` (700).

Line heights — `--line-height-tight` (1.2, headings), `--line-height-normal` (1.45, body and hints).

Do not introduce new font-size tokens outside the scale. If a design needs a value not in the scale, raise it before adding a new token — the scale is intentionally narrow to prevent drift. There are no `h1..h4` or `display` aliases; use the t-shirt sizes above directly.

4. Prefer import aliases

- Prefer project aliases over deep relative imports whenever an alias exists.
- Typical aliases are `@/*`, `@components/*`, `@constants/*`, `@hooks/*`, `@lib/*`, `@pages/*`, and `@types/*`.

5. Constants in dedicated files

- Do not keep reusable configuration constants inside component or page implementation files.
- Store shared constants in the project constants area:
  - `control-ui/app/constants`
  - `desktop-app/ui/src/constants`
  - `profile-ui/app/constants`
- Keep each constants file scoped to one module, page, or domain.
- Exception: local rendered copy that belongs to only one component can stay in the implementation file.

6. Prefer folder-based components

- Reusable components and route-section components should live in a folder named after the component.
- Use `index.tsx` as the entry file and keep related files beside it, such as `types.ts`, `constants.ts`, and local styles.
- Avoid flat `ComponentName.tsx` files for components that already have related files or are likely to gain them.

7. Use single-purpose components

- Prefer small, purpose-built UI primitives instead of repeating native form controls inline.
- Forms should compose common building blocks such as field wrappers, text inputs, textareas, select controls, checkboxes, and buttons.
- Button styles should collapse into explicit variants such as `primary`, `secondary`, `ghost`, or `danger` when behavior is equivalent.
- If two styles differ only by tiny cosmetic drift, choose one shared version instead of preserving both.
- Keep the primitive API narrow and behavior-oriented; do not build one oversized component that hides unrelated concerns.
- Desktop app controls must compose the shared controls in `desktop-app/ui/src/components/Common`
  (`Button`, `IconButton`, `TabButton`, `MenuItem`, `NavItem`, `Pill`, and `SelectableOption`) before adding local button/tab/menu markup.
- Interactive hover states must not move or scale controls. Do not add hover `transform`, `translate`, `top`, `margin`, or `filter` effects to buttons, tabs, menu items, pills, cards used as options, or navigation items. Use background, border, text color, and shadow tokens instead.

8. CSS class before inline style, always

- Never write `style={{ color: 'var(--cu-danger)' }}`. Use `.cu-field__error`, `.cu-text-danger`, or add a named class to the global stylesheet.
- The only exception is truly dynamic values (e.g., a progress bar width from JS state, or data-driven trust-chip colors).
- Inline styles on tables/columns break CSS override via media queries — use CSS classes for width and alignment.

9. One file owns shared styling per project

- All spacing, color, and layout primitives live in the project's global stylesheet:
  - `control-ui` → `app/globals.css`
  - `desktop-app/ui` → `src/styles/tokens.css`
  - `profile-ui` → `app/globals.css`
- Never create a `.module.css` or component-level stylesheet for anything shared.
- If a class doesn't exist yet, add it to the project's global stylesheet with the project's prefix (e.g., `cu-` for control-ui/profile-ui).

10. No duplicated utilities

- If you need `toKebabCase`, `joinClasses`/`cn`, or any string helper, look in the project's `lib/` first.
- If it's not there, create it once in the appropriate lib file (e.g., `lib/string.ts`, `lib/cn.ts`).
- Never define a helper function inline in a component file.

11. Page shell consistency

Each project has a page shell pattern that every page must follow. Don't invent new wrappers, don't use modal classes on full-screen pages, don't re-declare layout inside a page.

**control-ui / profile-ui** — full-screen create/install pages:

- Auth/load handling → wrapper component (e.g., `<AuthGate>`).
- Page header → consistent icon/title/subtitle/back button layout (e.g., `<CreatePageHeader>`).
- Content panel → shared panel class with max-width, shadow, padding.
- Form grid → shared grid layout for fields.
- Action buttons → Cancel (ghost) + Submit (primary) footer pattern.

**desktop-app/ui** — every top-level page:

- Outer `<section className="page">` containing a `.page-header` (`<h2>` + `<p className="muted">`) and a `.page-layout` with one or more `.page-card`s.
- Loading and empty states are `<EmptyState>` rendered inside a `.page-card`. No page-level skeletons.
- Errors are their own `.page-card` with `role="alert"` above the layout.
- Tabs use `.page-tabs` + `.page-tab.active`.
- Tabular listings use `.da-grid` with column widths driven by the inline CSS variable `--da-grid-cols` (constants in `src/lib/gridTemplates.ts`). This is the only acceptable inline-style use.
- Full pattern documented in `desktop-app/ui/docs/STYLE_STANDARDIZATION.md`.

12. Semantic heading levels

- Create page headers should use `<h2>` since the page-level heading is implicit from nav/sidebar context.
- Table panel headers use `<span>` (not headings). Modal panel heads use `<h3>`.
- Avoid multiple `<h1>` tags per page — hurts accessibility and SEO.

13. key props must be stable

- Never use array index as a React key for lists that can be reordered or have items removed.
- Use a stable ID (UUID at creation, or a natural unique value from data).

14. Accessibility: focus-visible on all interactive elements

- All non-input interactive elements (buttons, links, sidebar items, tabs) must have `:focus-visible` styles.
- Use `:focus-visible` (not `:focus`) to avoid showing outlines on mouse clicks.
- Focus rings should use the project's focus color token with appropriate offset.

15. Project-specific component patterns

Each project has established patterns for common UI surfaces:

**control-ui / profile-ui** (cu- prefix):

- Route section navigation must use canonical Next App Router paths and child
  route segments. Sidebar destinations and shareable tab-like sections must not
  use `?tab=...`, ad hoc query keys such as `profileTab`, `localStorage`, or
  component-only state as their routing source. The first/default tab may use
  the parent route; other tabs should use child routes such as
  `/hosts/[name]/env`, `/profile-admin/users`, or `/settings/social/telegram`.
  Query params are reserved for transient actions, form modes, filters, search,
  or external callback state, not primary section navigation.
- `TablePanelHeader` + `TableHeaderRow` for every route table/section
- Control UI route sections keep the header visible with icon, title, subtitle, search, refresh, and CTAs; initial loading belongs in the content area only, header CTAs are disabled during that initial load, and only the content pane scrolls when rows overflow.
- `CreatePageHeader` for every create/install page
- `cu-create-panel`, `cu-create-content`, `cu-create-actions` for create page shells
- `cu-modal-panel` reserved for overlay/dialog contexts only
- Transient success feedback for completed user actions must use the app toast/notification stack, not inline green success banners inside page cards or forms. Use inline status banners only for persistent page state, warnings, errors, or informational messages that should remain visible.

**desktop-app/ui** (`da-` prefix for shared primitives, unprefixed semantic names for shell):

- Page shell — `.page` / `.page-header` / `.page-layout` / `.page-card` / `.page-card__header`. See rule #11.
- Tabs — `.page-tabs` / `.page-tab` (with `.active`). Legacy aliases (`agents-fleet-tabs`, `context-tabs`, `team-tabs`) share styles via grouped selectors; new code uses `.page-tabs` only.
- Controls — use `Button`, `IconButton`, `TabButton`, `MenuItem`, `NavItem`, `Pill`, and `SelectableOption` from `@components/Common`. Variant/style decisions belong in the component props (`variant`, `color`, `size`, `block`, `loading`, `align`) plus semantic class names for layout only.
- DataGrid — `.da-grid` with BEM elements (`__head`, `__col-header`, `__body`, `__row`, `__cell`) and modifiers (`--clickable`, `--selected`, `--compact`, `--center`, `--right`). Column widths via `--da-grid-cols` inline; shared templates in `src/lib/gridTemplates.ts`.
- Transient success feedback for completed user actions must use the app toast stack, not inline green success banners inside page cards or forms. Use inline status banners only for persistent page state, warnings, errors, or informational messages that should remain visible.
- Pages live in `src/pages/` — flat `<Name>Page.tsx` for top-level, folder-based `<Name>Page/index.tsx` only for auth/error pages.
- Three legacy component CSS files (`ChatListPanel.css`, `ProgressStepper.css`, `ArtifactsBadge.css`) exist but **must not be extended** — migrate rules into `styles.css` opportunistically.
- Full pattern reference: `desktop-app/ui/docs/STYLE_STANDARDIZATION.md`.

## 16. Automated enforcement (style-rules)

A repo-local checker at `scripts/style-rules/` runs on `pre-commit` and enforces a
subset of the rules above. Currently scoped to `desktop-app/ui/**`. It blocks commits on:

- Hex literals in CSS outside `tokens.css` and the 3 legacy files.
- Raw `font-size` values (must use `var(--font-size-*)`).
- New component-level `.css` files outside the 5-file allowlist.
- Hover `transform` / `filter` effects in desktop CSS. Hover states can change
  background, border, text color, and shadow, but must not move, scale, or
  brightness-filter controls.

It also surfaces warnings (non-blocking) for hex literals in TS/TSX strings and JSX
inline `style={{…}}` other than `--da-grid-cols`. Manual run: `npm run style-rules`
(add `-- --strict` to fail on warnings, e.g. for CI).

Extend coverage to control-ui / profile-ui by broadening the rule predicates in
`scripts/style-rules/rules.mjs` once their patterns consolidate. Don't add rules
without a corresponding entry in this doc — undocumented rules cause drift, not prevent it.
