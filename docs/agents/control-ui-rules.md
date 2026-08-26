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

- Use `TablePanelHeader` and `TableHeaderRow` for route tables and sections.
- Keep the section icon, title, subtitle, search, refresh, and CTAs visible
  while initial loading, empty, and error states render in the content area.
  Disable header CTAs during initial loading, and let only the content pane
  scroll when rows overflow.
- Use `CreatePageHeader` plus `cu-create-panel`, `cu-create-content`, and
  `cu-form-grid` for full-screen create/install pages. Put Cancel in a ghost
  button and Submit in a primary button inside `cu-create-actions`. Use `<h2>`
  for the create-page heading.
- Wrap auth-gated pages in `<AuthGate>`.
- Reserve `cu-modal-panel` for overlay/dialog contexts. Modal panel headings use
  `<h3>`; table panel labels are not headings.
