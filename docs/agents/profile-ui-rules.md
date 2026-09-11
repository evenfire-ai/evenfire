# Profile UI coding rules

These provider-neutral rules apply only to `profile-ui/**`. Combine them with
[`frontend-style-rules.md`](./frontend-style-rules.md). They do not apply to
`control-ui`, Desktop, backend services, deployment manifests, or shared docs.

## Styling and components

- `app/globals.css` owns Profile UI token declarations and shared CSS
  classes/layout. Consume colors, spacing, radii, shadows, motion, and z-index
  through its CSS variables instead of hardcoding tokenized values.
- Continue using the `cu-` prefix shared with Control UI.
- Components and primitives remain colocated under `app/components/` in
  folders with `index.tsx` and colocated support such as `types.ts`. Do not
  migrate Profile UI to Control UI's `components/ui/` structure.
- Reusable configuration constants live under `app/constants/`.
- Reuse Profile UI's existing form primitives, including `Button`, `TextInput`,
  `SelectControl`, and `FormField`. Use `@clerum/frontend-components` for
  tables and repeated record lists; the obsolete local `EditableList` has been
  removed.

## Tables and record lists

- Use the shared `DataTable`/`TableHeaderCell` contract for member, invitation,
  and permission matrices. Use `RecordList`/`RecordListRow` for settings and
  connected-account rows that do not need comparable column headers.
- Ordinary member rows navigate to `PROFILE_ROUTES` detail destinations and
  place every record-specific operation in the shared `RowActionMenu`.
- Preserve permission checkboxes and invitation selection as specialized table
  interactions. They remain explicit controls and must not trigger row
  navigation.
- Do not recreate `.members-table` styling or a Profile-only table primitive;
  use shared modifiers such as `eft-table--wide` and keep only genuine
  Profile-specific presentation in `app/globals.css`.

## Routing

- Sidebar destinations and shareable tab-like sections use canonical Next App
  Router paths and child route segments. Do not use `?tab=...`, `profileTab`,
  `localStorage`, or component-only state as the section-routing source.
- Query parameters remain valid for transient actions, form modes, filters,
  search, and external callback state; they are not primary section navigation.
- Import internal destinations and dynamic/query builders from
  `app/constants/routes.ts`. Never inline Profile UI paths in links, redirects,
  router actions, sidebar items, or tabs. Pass raw dynamic identifiers to the
  route builder.

## Page patterns

- Use Profile UI's existing `AuthGate`, `CreateFlowPanel`, `CreatePageHeader`,
  `CreateStepFlow`, `cu-agent-form-stack`, and `cu-create-actions` patterns for
  authenticated create/install flows. Put Cancel or Back in a ghost button and
  the primary continuation or submit action in the default primary button.
- Full-screen create/install headings use `<h2>`. Modal panel headings use
  `<h3>`; table or panel labels are not headings.
- Reserve `cu-modal-panel` for overlay/dialog contexts rather than full-screen
  pages.
