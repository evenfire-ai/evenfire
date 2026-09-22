# Shared frontend rules

These provider-neutral rules apply only to:

- `control-ui/**`
- `profile-ui/**`
- `desktop-app/ui/**`

They do not apply to `desktop-app/**` outside `ui/**` or to other repository
services. The applicable provider adapter also selects the provider-neutral
application guidance that must be combined with this shared document.

## Preserve behavior

- Preserve established interaction behavior before simplifying structure or
  styling.
- Keep disabled, loading, hover, focus, validation, error, and empty states
  working.
- Consolidate variants that are semantically equivalent, but do not flatten
  intentional application differences.

## Types, constants, and imports

- Do not declare exported or reusable `type` or `interface` definitions inside
  component implementation files. Put them in a sibling `types.ts` or
  `*.types.ts` file and import them.
- Keep reusable configuration constants in the application's constants area.
  Local rendered copy used by only one component may remain in that component.
- Keep each constants file scoped to one module, page, or domain.
- Prefer project aliases over deep relative imports when an alias exists. The
  shared examples configured across all three targets are `@/*`,
  `@components/*`, `@constants/*`, and `@lib/*`; use narrower app-defined
  aliases only where that application's TypeScript and bundler/test config
  define them.

## Tokens and shared CSS ownership

- Do not hardcode colors in component styles. Consume project tokens through
  `var(--token-name)`.
- Prefer existing tokens for spacing, radii, font sizes, shadows, and motion.
  Add a scoped token only when no existing token fits; promote it to the
  application's token file only when it is shared.
- Use the target application's established typography and font-size scale
  before adding a new value. Do not introduce a new font-size token outside the
  application's scale without an explicit design decision. Desktop's exact
  scale is owned by its renderer standard; Control UI and Profile UI continue
  to follow the values established in their own global stylesheets until their
  typography is consolidated.
- Use the application's spacing scale instead of introducing raw `rem` values.
- Put token declarations and shared CSS classes/layout in the files below.
  Token files declare values; shared-style files own reusable selectors.

| Application      | Token declarations      | Shared CSS classes and layout |
| ---------------- | ----------------------- | ----------------------------- |
| `control-ui`     | `app/globals.css`       | `app/globals.css`             |
| `profile-ui`     | `app/globals.css`       | `app/globals.css`             |
| `desktop-app/ui` | `src/styles/tokens.css` | `src/styles.css`              |

- Do not create a CSS module or component-level stylesheet for shared styles.
- Prefer a named CSS class over inline style. Inline style is reserved for
  values that are genuinely computed at runtime; an application's narrower
  guidance may restrict this further.
- Use CSS classes for table and column width or alignment when responsive
  styles need to override those values.

## Components and controls

- Prefer small, single-purpose primitives over repeated native form controls.
  Compose field wrappers, text inputs, textareas, selects, checkboxes, and
  variant-driven buttons from the target application's established primitives.
- Keep primitive APIs narrow and behavior-oriented. Consolidate cosmetic-only
  variants rather than building an oversized component.
- Express behaviorally distinct button styles through the application's
  established variants, such as `primary`, `secondary`, `ghost`, or `danger`,
  rather than duplicating button markup.
- Reusable components and route-section components should use the target
  application's established folder convention. Keep related `types.ts`,
  `constants.ts`, and other support files beside the component.
- Interactive hover states must not move, scale, translate, reposition, or
  brightness-filter controls. Use background, border, text color, and shadow
  tokens instead of `transform`, `translate`, `top`, `margin`, or `filter`.

## Edit dialogs and modal workflows

- From a read surface, edit one scalar value with `SingleValueEditDialog`;
  do not transform the displayed value inline into an editor. For an existing
  record with at most four simple controls, use `SimpleEditDialog`. The limit
  does not apply to tabs, tables, rich text, repeatable collections,
  verification, ordered policies, or long explanatory/review content.
- Edit a child scalar or write-only value directly inside an already-active
  parent editor. Its value participates in the parent's final Save; do not
  open a nested dialog just to edit that child value.
- Keep creation steppers only for actual sequence or dependency. Edit an
  existing long-form record on a full page, choosing long-form or tabs to fit
  the domain structure rather than reusing a creation stepper for grouping.
- Model relationships with structural selection/action patterns, not scalar
  form edits. Immediate toggles/actions and collection selection/actions are
  distinct workflows, not ordinary edit dialogs.
- Use the shared `@clerum/frontend-components` `DialogShell` as the modal
  boundary. Compose it with `ConfirmationDialog`, `SingleValueEditDialog`,
  `SimpleEditDialog`, `SecretEditField`, or `MultiSelectActionDialog` when that
  primitive matches the interaction; keep routes, permissions, API calls, and
  domain-specific validation in the owning application.
- Keep dialog titles at the established modal heading level (`h3`). Provide a
  useful accessible name and connect any explanatory copy and live feedback to
  the dialog. Use alert-dialog semantics for consequential confirmations only.
- A dialog opened from a keyboard-operable control must focus into the dialog,
  contain Tab and Shift+Tab navigation, support Escape and explicit close or
  cancel paths when safe, and return focus to its opener when dismissed. A
  backdrop click may dismiss only when that matches the workflow.
- Pending mutations must disable duplicate actions and prevent accidental
  dismissal when the operation cannot safely be interrupted. Show progress and
  actionable errors in the dialog; do not report success until the owning
  mutation has completed.
- Single-value editing must keep its draft atomic, distinguish unchanged,
  invalid, and pending states, and avoid enabling Save when no change is made.
  Multi-field dialogs must keep field ownership and validation in the app and
  enable Save only when the form is valid, changed, and not pending.
- Secret editing is write-only: never fetch or render an existing secret as an
  input value. Represent keep, replace, clear, and restore as explicit states;
  a blank untouched or restored input means preserve the existing value, not
  clear it. Save interprets replaced as write and cleared as remove.
- Multi-select action dialogs must expose labeled choices, preserve disabled
  item constraints, filter by explicit searchable text, and enable the action
  only when the selection is actionable and no load or mutation is pending.
- Keep dialogs centered at narrow and regular viewports, using the shared
  bounded width, viewport height, and padding conventions. Keep content
  scrollable within the viewport and action controls reachable without
  horizontal overflow; do not introduce an unapproved mobile sheet pattern.
- Staged editors preserve drafts after failure, expose explicit completion,
  and preserve the owning app's existing `resourceVersion`/CAS behavior.
- Keep these primitives composable and semantic; do not encode API requests,
  resource identities, access policy, or product-specific copy in the shared
  package. Add a specialized primitive only after the same bounded behavior is
  needed across applications. Shared presentation mechanics may live here;
  routes, APIs, auth, permissions, CAS, and domain logic remain app-owned.

## Tables and record lists

- `packages/frontend-components` is the shared semantic and visual boundary
  for Control UI and Profile UI tables and table-like record lists. Import its
  `DataViewHeader`, `TableSearch`, `TableViewport`, `DataTable`, `TableRow`,
  table cells/state rows, `RecordList`, `RecordListRow`, `RowActionMenu`, and
  sorting helpers instead of creating an application-local table system.
- Render standardized Control UI and Profile UI table viewports through the
  shared `TableViewport` component. Application production code must not
  author `eft-table-viewport` or its modifier classes directly; pass supported
  modifiers and domain layout hooks through the component instead.
- Use a semantic `DataTable` for comparable columns and `RecordList` for a
  repeated record layout that does not need column headers. Do not write raw
  production `<table>` markup in either web application. Choose the standard,
  navigable, selection/permission, hierarchy/file, or embedded/diagnostic
  behavior deliberately; do not encode variants as a growing set of unrelated
  boolean props.
- Keep the title, description, search, refresh, and primary CTA in one
  `DataViewHeader`-based toolbar. Loading, empty, and error states belong in the
  table/list content area and must not remove the toolbar. Use the established
  search input and at most the application's primary, secondary, and
  tertiary/ghost page-action variants. Place route-backed tabs below the page
  identity and toolbar, and flatten category-wrapper plus child-list double
  tabs into sibling destinations when no information-architecture decision is
  required. Do not keep an org, deploy, or category wrapper tab solely to hold
  another row of list tabs; put that scope in the active tab description
  instead.
- Fill the available content width. Keep fixed widths for genuinely compact
  numeric, status, selection, icon, and action cells; allow ordinary text
  columns to size flexibly. Put secondary metadata such as descriptions,
  emails, providers, aliases, or namespaces in accurately named columns rather
  than stacking it under a primary label. Truncate bounded, non-critical text
  only when its complete value remains accessibly available; use the shared
  bounded-text primitive for table descriptions unless a domain-specific
  control owns the full-value affordance.
- Let shared table empty states default to `No data`. Override that copy only
  when a search/filter, loading/error state, or domain-specific next action
  changes what the user needs to know.
- Make ordinary record rows navigate to their dedicated detail route. Do not
  use inline master/detail expansion for normal record tables; reserve
  expansion or hierarchy for a genuinely specialized tree, file, permission,
  or selection workflow. Child links, buttons, checkboxes, and menus keep their
  own destinations/actions and must not activate the row. Remove redundant
  same-destination inspect links and chevrons.
- Put every record-specific operation in the shared, accessible three-dot
  `RowActionMenu` at the far right. The menu includes the detail action when the
  row itself navigates and has other actions; put that detail action first and
  keep destructive actions clearly labelled.
- Use stable sorting with a deterministic default and `aria-sort` for every
  meaningful data column. Fully loaded collections sort locally without a
  refetch. Producer-backed paginated data must sort at the producer/API
  boundary before cursor slicing, bind cursor continuation to the selected
  order, and reset pagination when ordering changes; sorting only the loaded
  page is not authoritative.
- Require an explicit owner/product presentation decision when either the
  dataset is known or identified to be unusually long, including when the
  owner says its presentation needs reconsideration, or a meaningful candidate
  grouping column has at least three distinct values and every one of those
  values occurs at least four times. Formally, the repetition gate is met when
  at least three distinct values `v` satisfy `count(C = v) >= 4` for candidate
  column `C`; three repeated rows or one value occurring four times is not
  sufficient. The gate does not choose the presentation. The recorded decision
  may retain a flat sortable/filterable table, or choose grouped expansion,
  segmentation, pagination, virtualization, or another domain-appropriate
  presentation. Record the choice in the active specification or decision
  context when one exists. Expandable rows remain exceptional and must use an
  explicit shared primitive rather than changing ordinary `DataTable` rows.
  When a grouped summary exposes column-shaped values, use
  `GroupedTableBody.summaryCells` and mirror the visible header `colSpan`
  values. Native table cells own alignment for every valid column count; do
  not reproduce header lanes with app-specific flex/grid widths or positional
  selectors. When expanded rows expose a different column schema, use the
  grouped `DataTable` variant and `GroupedTableBody.nestedChildTable`; do not
  force summary and child schemas into one physical column grid. The grouped
  parent shares available width across its non-action columns and reserves a
  fixed, right-aligned final Actions lane. Domain-specific child widths belong
  to the nested table through `childTableClassName`.
- Keep standard rows compact and consistent. Use `TableViewport` for horizontal
  overflow and for long-list body scrolling so the page title, toolbar, tabs,
  and semantic sticky table header remain visible. Embedded/diagnostic views
  may use the less restrictive viewport mode when page-level scrolling is the
  appropriate contract.
- Inline record expansion is not a storage location for data. Promote small
  facts to columns, expose bounded text with an accessible full-value
  affordance, and move large structured content to the canonical detail route.
- Preserve specialized selection, permission, file, and tree semantics as
  explicit variants. Sharing the foundation does not make those workflows
  ordinary navigable record tables. Embedded diagnostic tables share the
  structure and typography but may retain product-defined chronological order
  or local toolbar placement.
- After migrating a family, prove the superseded component, selector, helper,
  expansion state, and tests have zero production consumers before deleting
  them. Do not create a parallel app-local table shell for convenience.

## Utilities

- Search the target application's `lib/` before adding string helpers such as
  `toKebabCase`, `joinClasses`, or `cn`.
- Create a missing reusable helper once in the appropriate library file. Do not
  define reusable utilities inline in a component.

## Feedback and accessibility

- Use the application's toast/notification stack for transient success after a
  completed action. Inline status banners are for persistent page state,
  warnings, errors, or information that must remain visible while the user
  acts.
- Use stable React keys for lists that can reorder or remove items. Never use
  an array index for those lists; use a UUID assigned at creation or a natural
  unique identifier from the data.
- Give every non-input interactive element a token-based `:focus-visible`
  treatment with an appropriate offset. Use `:focus-visible`, not `:focus`, so
  mouse clicks do not show a keyboard focus ring.
- Maintain a meaningful heading hierarchy and avoid multiple `<h1>` elements
  on one page. Follow the application's canonical page and modal heading
  levels.
