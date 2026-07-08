import type { PageBreadcrumbProps } from './types'

function BreadcrumbSeparator() {
  return (
    <span className="page-breadcrumb-separator" aria-hidden="true">
      /
    </span>
  )
}

export function PageBreadcrumb({ ariaLabel, items }: PageBreadcrumbProps) {
  if (items.length === 0) return null

  return (
    <nav className="page-breadcrumb" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        return (
          <span className="page-breadcrumb-item" key={index}>
            {item.onClick ? (
              <button
                className={`page-breadcrumb-link ${isLast ? 'is-current' : ''}${
                  item.className ? ` ${item.className}` : ''
                }`}
                onClick={item.onClick}
                type="button"
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </button>
            ) : (
              <span
                className={`page-breadcrumb-link ${isLast ? 'is-current' : ''}${
                  item.className ? ` ${item.className}` : ''
                }`}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </span>
            )}
            {!isLast ? <BreadcrumbSeparator /> : null}
          </span>
        )
      })}
    </nav>
  )
}
