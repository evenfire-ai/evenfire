export function RegistryEntryDetailSkeleton() {
  return (
    <div
      className="cu-card"
      role="status"
      aria-label="Loading Marketplace entry"
      aria-live="polite"
    >
      <div className="cu-card__body cu-marketplace-detail cu-marketplace-detail-skeleton">
        <div className="cu-marketplace-detail__summary">
          <div className="cu-chip-row">
            <span className="cu-skeleton cu-marketplace-detail-skeleton__chip" />
            <span className="cu-skeleton cu-marketplace-detail-skeleton__chip" />
            <span className="cu-skeleton cu-marketplace-detail-skeleton__chip cu-marketplace-detail-skeleton__chip--wide" />
            <span className="cu-skeleton cu-marketplace-detail-skeleton__chip" />
          </div>
        </div>

        <section className="cu-marketplace-detail__section">
          <span className="cu-skeleton cu-marketplace-detail-skeleton__heading" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__line" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__line cu-marketplace-detail-skeleton__line--medium" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__line cu-marketplace-detail-skeleton__line--short" />
        </section>

        <section className="cu-marketplace-detail__section">
          <span className="cu-skeleton cu-marketplace-detail-skeleton__heading" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__line cu-marketplace-detail-skeleton__line--image" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__line cu-marketplace-detail-skeleton__line--image-short" />
        </section>

        <section className="cu-marketplace-detail__section">
          <span className="cu-skeleton cu-marketplace-detail-skeleton__heading cu-marketplace-detail-skeleton__heading--code" />
          <span className="cu-skeleton cu-marketplace-detail-skeleton__code" />
        </section>
      </div>
    </div>
  )
}
