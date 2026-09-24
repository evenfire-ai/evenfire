export type RegistryApiKeysPanelProps = {
  /**
   * Set when the panel is rendered inside a host card. `cu-card--viewport-fill`
   * means "fill the viewport"; nesting two of them produced the card-in-card
   * double border on the Marketplace org area.
   */
  embedded?: boolean
  hideHeader?: boolean
  search?: string
  refreshSignal?: number
  createSignal?: number
  onCreateAvailabilityChange?: (available: boolean) => void
}
