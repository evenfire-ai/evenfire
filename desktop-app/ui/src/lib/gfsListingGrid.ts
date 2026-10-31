/**
 * The column template of the EvenDrive listing grid, shared by the Files page
 * listing and the overview's "Recent files" card so the two grids read as one
 * surface (STYLE_STANDARDIZATION §3 rule 1: a template shared by two or more
 * grids is a named constant under `src/lib/`).
 *
 * icon · name · size · trailing lane. The trailing lane is the listing's
 * actions lane and the card's "Your activity" lane, both 9.5rem.
 */
export const GFS_LISTING_GRID_COLUMNS =
  'calc(var(--space-5) + var(--space-1)) minmax(0, 1fr) minmax(4.5rem, auto) 9.5rem'
