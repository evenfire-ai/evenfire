# `@clerum/frontend-components`

The canonical cross-application component package shared by Control UI and
Profile UI. Its current public surface provides the common table and record-list
primitives; other genuinely shared frontend components can live here without
creating another narrowly named package.

Import composable React primitives from `@clerum/frontend-components` and
import the single global stylesheet from
`@clerum/frontend-components/styles.css` in each application's root layout.
Apps retain ownership of data loading, routes, permissions, domain cells, and
mutation behavior.

The root `src/index.tsx` file is the stable public barrel. Table and record-list
implementation is organized under `src/table/` by responsibility: shells,
semantic primitives, actions, truncation, sorting, and public types. Consumers
must continue importing from `@clerum/frontend-components`; internal module
paths are not part of the supported API.
