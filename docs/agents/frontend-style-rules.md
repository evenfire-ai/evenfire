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

## Tables and record lists

- `packages/frontend-components` is the shared semantic and visual boundary
  for Control UI and Profile UI tables and table-like record lists. Import its
  `DataViewHeader`, `TableSearch`, `TableViewport`, `DataTable`, `TableRow`,
  table cells/state rows, `RecordList`, `RecordListRow`, `RowActionMenu`, and
  sorting helpers instead of creating an application-local table system.
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
  required.
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
