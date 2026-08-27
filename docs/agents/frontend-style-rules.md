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
- Prefer project aliases over deep relative imports when an alias exists.

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
