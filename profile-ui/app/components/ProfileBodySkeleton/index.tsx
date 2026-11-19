type ProfileBodySkeletonSection = {
  actions?: string[]
  rows?: number
  title: string
}

export function ProfileBodySkeleton({
  label,
  sections,
  showHead = true,
}: {
  label: string
  sections: ProfileBodySkeletonSection[]
  showHead?: boolean
}) {
  return (
    <div className="profile-body-skeleton" role="status" aria-label={label} aria-busy="true">
      {sections.map(section =>
        showHead ? (
          <section className="section" key={section.title}>
            <div className="settings-section-head">
              <h2 className="section-title">{section.title}</h2>
              {section.actions?.length ? (
                <div className="toolbar">
                  {section.actions.map(action => (
                    <button type="button" className="cu-btn" disabled key={action}>
                      {action}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="profile-skeleton">{renderSkeletonRows(section)}</div>
          </section>
        ) : (
          <div className="profile-skeleton" key={section.title}>
            {renderSkeletonRows(section)}
          </div>
        )
      )}
    </div>
  )
}

function renderSkeletonRows(section: ProfileBodySkeletonSection) {
  return Array.from({ length: section.rows ?? 3 }, (_, index) => (
    <div className="profile-skeleton__row" key={index}>
      <span className="profile-skeleton__line profile-skeleton__line--medium" />
      <span className="profile-skeleton__line" />
      <span className="profile-skeleton__line profile-skeleton__line--short" />
    </div>
  ))
}
