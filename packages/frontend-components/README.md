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
