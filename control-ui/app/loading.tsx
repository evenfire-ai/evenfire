import { SectionLoadingSkeleton } from '@components/SectionLoadingSkeleton'

export default function Loading() {
  return (
    <section className="cu-card">
      <div className="cu-card__body">
        <SectionLoadingSkeleton label="Loading Control UI section" rows={4} />
      </div>
    </section>
  )
}
