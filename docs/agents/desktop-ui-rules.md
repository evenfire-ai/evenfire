# Desktop renderer coding rules

These provider-neutral rules apply only to `desktop-app/ui/**`. Combine them
with [`frontend-style-rules.md`](./frontend-style-rules.md) and
[`../../desktop-app/ui/docs/STYLE_STANDARDIZATION.md`](../../desktop-app/ui/docs/STYLE_STANDARDIZATION.md).

They do not apply to `desktop-app/**` outside `ui/**`. Electron main-process,
preload, IPC, and shared scripts follow the repository-wide guidance and their
existing local contracts, not renderer styling or page-layout rules.

## Navigation

- Reusable configuration constants live under `src/constants/`.
- Import top-level and nested in-memory destinations from
  `src/constants/navigation.ts`.
- Never inline Desktop route IDs in navigation handlers, comparisons, sidebar
  definitions, or view switches. Keep `NavItem` derived from the centralized
  navigation contract.

## Server state

- Every new top-level data section that reads server data uses TanStack Query
  as its server-state source of truth.
- Add a dedicated `use<Section>DataController()` or equivalently scoped query
  hook. Keep exported/reusable types in separate files and expose `loading`,
  `error`, required data, and `refresh()`.
- Consume query hooks directly where needed. Do not wrap `App` in section data
  providers or re-expose query state through React context; reserve contexts
  for client UI state and cross-cutting actions.
- Initial loads run once after successful authentication. Section navigation
  reads the current query/cache state, and manual refreshes refresh only that
  section unless the app-level refresh flow explicitly coordinates several
  sections.

## Visual and component architecture

Shared feedback and accessibility semantics, including toast versus inline
status placement, are owned by `docs/agents/frontend-style-rules.md`.
`desktop-app/ui/docs/STYLE_STANDARDIZATION.md` is authoritative for
Desktop-specific renderer tokens, shared CSS ownership, Common controls, page
placement, page shells, tabs, DataGrid, visual/layout treatment for feedback
components, and style-rule enforcement.
