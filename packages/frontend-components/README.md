# `@clerum/frontend-components`

The canonical cross-application component package shared by Control UI and
Profile UI. Its public surface provides common table, record-list, and edit
dialog primitives; other genuinely shared frontend components can live here
without creating another narrowly named package.

Import composable React primitives from `@clerum/frontend-components` and
import the single global stylesheet from
`@clerum/frontend-components/styles.css` in each application's root layout.
Apps retain ownership of data loading, routes, permissions, domain cells, and
mutation behavior.

The root `src/index.tsx` file is the stable public barrel. Table and record-list
implementation is organized under `src/table/`; shared edit interactions are
organized under `src/edit/`. Consumers must continue importing from
`@clerum/frontend-components`; internal module paths are not part of the
supported API.

The edit family provides `DialogShell`, `ConfirmationDialog`,
`SingleValueEditDialog`, `SimpleEditDialog`, `SecretEditField`, and
`MultiSelectActionDialog`. These components standardize modal accessibility,
bounded draft/action states, and shared styling. They do not own routes, access
checks, API requests, domain validation, or resource identity. Import the
package stylesheet once from each application root layout. See
`docs/agents/frontend-style-rules.md` for the cross-app interaction contract.

Grouped tables use `GroupedTableBody`. Use `summaryCells` when a summary row
must align with visible column headers: each definition renders a native table
cell and its optional `colSpan` must mirror the corresponding header span. The
component validates that the summary spans cover the complete grouped row, so
new grouped layouts do not need app-specific grid or positional CSS. The
single `summary` prop remains available for intentionally full-width summaries.

When expanded child rows use a different column schema, set `nestedChildTable`
and use the `grouped` `DataTable` variant on the parent. The parent summary
columns then share their available width independently, with a fixed final
Actions lane, while the child header and rows remain a separate semantic table.
Use `childTableClassName` to set domain-specific minimum widths on that child
table without changing the provider-summary columns.
