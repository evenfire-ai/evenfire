export type DropdownSelectOption = {
  label: string
  value: string
}

export type DropdownSelectProps = {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  id?: string
  onChange: (value: string) => void
  options: DropdownSelectOption[]
  placeholder: string
  /** Render the menu in a portal (see `portalContainer`) so ancestor overflow cannot clip it. */
  portal?: boolean
  /**
   * Where a `portal` menu mounts. Defaults to document.body. A caller inside a
   * modal layered above the dropdown layer passes its dialog element so the
   * menu joins the modal's stacking context instead of painting under it.
   * When an ancestor of the container (e.g. a backdrop-filtered, scrollable
   * modal) becomes the menu's fixed containing block, the menu measures that
   * block's origin and compensates its position. Ignored unless `portal` is set.
   */
  portalContainer?: HTMLElement | null
  value: string
}
