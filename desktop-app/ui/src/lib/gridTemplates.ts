/**
 * Shared `--da-grid-cols` templates.
 *
 * Use these constants instead of hardcoding strings inline whenever a column
 * template is shared across multiple tables. For templates that exist in only
 * one place, prefer keeping the literal inline (co-located with the JSX that
 * describes the columns).
 *
 * See `desktop-app/ui/docs/STYLE_STANDARDIZATION.md` for the full convention.
 */

/**
 * 4-column "scoped resource" listing used by:
 *   - `ContextsPage` (main contexts list)
 *   - `ContextDetailsPage` (agents tab, teams tab)
 *   - `TeamDetailsPage` (contexts tab, agents tab)
 *
 * Layout: id/name | scope-badge | access-pill | access-pill.
 */
export const SCOPED_RESOURCE_4COL =
  'minmax(0, 1.5fr) minmax(0, 0.9fr) minmax(0, 0.85fr) minmax(0, 0.85fr)'

/**
 * 3-column members listing (Name + Email + Role) used by:
 *   - `ContextDetailsPage` (members tab)
 *   - `TeamDetailsPage` (members tab)
 */
export const MEMBERS_3COL = 'minmax(170px, 1.2fr) minmax(220px, 1.6fr) minmax(120px, 0.7fr)'
