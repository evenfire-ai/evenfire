# AGENTS.md — desktop-app/ui

This is one of three frontend projects in the monorepo. It follows two layered sources of truth:

1. **Cross-app rules** — [`../../docs/agents/frontend-style-rules.md`](../../docs/agents/frontend-style-rules.md). Tokens, primitives, accessibility, semantic headings, etc. Read first.
2. **desktop-app-specific patterns** — [`docs/STYLE_STANDARDIZATION.md`](./docs/STYLE_STANDARDIZATION.md). The page shell, tabs, DataGrid, where pages live, and what not to extend. **Read this before touching any page or shared style.**

If those two docs disagree (they shouldn't), the cross-app doc wins for token/primitive concerns; STYLE_STANDARDIZATION wins for desktop-app layout shape.

## Project-specific notes

- **Token file:** `src/styles/tokens.css` — colors, spacing (`--space-*`), radii, shadows, motion, typography (`--font-size-*`, `--font-weight-*`, `--line-height-*`), z-index layers, table/grid surfaces. Consume via `var(--token)`. Never hardcode hex or raw px for these properties.
- **Class prefix:** `da-` for shared, primitive-style classes (e.g. `da-grid`). Page shell and tabs use unprefixed semantic names (`page`, `page-card`, `page-tabs`) — that's intentional, don't migrate them.
- **Global stylesheet:** `src/styles.css` — shared layout, primitives, patterns. Add new shared classes here at the end of the relevant section. **Do not** create new component-level `.css` files.
- **Common controls:** `src/components/Common/<Component>/index.tsx` with colocated `types.ts`, re-exported from `src/components/Common/index.ts` — `Button`, `IconButton`, `TabButton`, `MenuItem`, `NavItem`, `Pill`, `SelectableOption`, `TextInput`, `SelectInput`, `Field`, `Badge`, `StatusBanner`, `EmptyState`, `DetailRow`, `ToastStack`. Use them; don't recreate.
- **Control behavior:** Follow the shared control rules from `../../docs/agents/frontend-style-rules.md`: compose the Common controls before adding native button/tab/menu/option markup, and never use hover `transform`, `translate`, `top`, `margin`, or `filter` effects for interactive controls. Hover states should use background, border, text color, or shadow.
- **Pages:** `src/pages/` — top-level pages are flat `<Name>Page.tsx`; only auth/error pages use folder-based `<Name>Page/index.tsx`.

## Quick rules (the things that drift first)

- Every page starts with `<section className="page"><div className="page-header"><h2>…</h2><p className="muted">…</p></div>` followed by a `.page-layout` containing one or more `.page-card`s. Loading and empty states use `<EmptyState>` inside a `.page-card` — no page-level skeletons.
- Every new top-level data section that reads server data must use TanStack Query as the server-state source of truth. Add a dedicated `use<Section>DataController()` (or similarly scoped query hook), keep exported/reusable types in separate files, expose `loading`, `error`, required data, and `refresh()`, and consume the hook directly where needed. Do not wrap `App` in section data providers or re-expose query state through React context; reserve contexts for client UI state and cross-cutting actions. Initial loads must run once after successful authentication, section navigation must only read the current query/cache state, and manual refreshes must refresh only that section unless the app-level refresh flow explicitly coordinates multiple sections.
- Tabular listings use `.da-grid` (with `__head`, `__body`, `__row`, `__cell` and modifiers `--clickable`, `--selected`, `--center`, `--right`). Column widths flow through the inline CSS variable `--da-grid-cols`; shared templates live in `src/lib/gridTemplates.ts`. **This is the only inline-style use that's allowed.**
- Tabs use `.page-tabs` + `.page-tab` with `.active`. Don't create new tab class families per domain.
- Controls use the shared Common components with `variant`, `color`, `size`, `block`, `loading`, and `align` props. Keep semantic class names for layout only.
- Hover states must not move, scale, translate, or brightness-filter controls. `npm run style-rules` enforces hover `transform` / `filter` failures in desktop CSS.
- Success feedback for completed user actions should use the app toast stack, not inline green success banners inside page cards or forms. Reserve inline `StatusBanner` for persistent page state, errors, warnings, or information the user may need to keep seeing while they act.
- Three legacy component CSS files exist (`ChatListPanel.css`, `ProgressStepper.css`, `ArtifactsBadge.css`). **Don't extend them** — migrate rules into `styles.css` opportunistically (boy-scout) when you touch the surface.
- A pre-commit checker at `scripts/style-rules/` enforces the hex/font-size/new-CSS rules. Run `npm run style-rules` to validate before committing; see `STYLE_STANDARDIZATION.md` §7.

## Outside this directory

These rules are scoped to `desktop-app/ui/**`. Code in `desktop-app/` (the Electron main process and shared scripts) follows the repository's general TypeScript/Node conventions, not these UI rules.
