import { joinClasses } from '@lib/classNames'
import type { ReferenceTagKind, ReferenceTagProps } from './types'

export function ReferenceTag({
  children,
  className,
  disabled = false,
  kind = 'context',
  onClick,
  ...props
}: ReferenceTagProps) {
  const interactive = Boolean(onClick) && !disabled
  const content = (
    <>
      <ReferenceTagIcon kind={kind} />
      <span className="reference-tag__label">{children}</span>
    </>
  )
  const classes = joinClasses(
    'reference-tag',
    `reference-tag--${kind}`,
    interactive && 'reference-tag--button',
    disabled && 'reference-tag--disabled',
    className
  )

  if (interactive) {
    return (
      <button {...props} className={classes} onClick={onClick} type="button">
        {content}
      </button>
    )
  }

  return (
    <span
      className={classes}
      title={props.title}
      aria-disabled={disabled ? 'true' : undefined}
      aria-label={props['aria-label']}
    >
      {content}
    </span>
  )
}

function ReferenceTagIcon({ kind }: { kind: ReferenceTagKind }) {
  if (kind === 'agent') {
    return (
      <svg className="reference-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13.5 2C13.5 2.44425 13.3069 2.84339 13 3.11805V5H18C19.6569 5 21 6.34315 21 8V18C21 19.6569 19.6569 21 18 21H6C4.34315 21 3 19.6569 3 18V8C3 6.34315 4.34315 5 6 5H11V3.11805C10.6931 2.84339 10.5 2.44425 10.5 2C10.5 1.17157 11.1716 0.5 12 0.5C12.8284 0.5 13.5 1.17157 13.5 2ZM6 7C5.44772 7 5 7.44772 5 8V18C5 18.5523 5.44772 19 6 19H18C18.5523 19 19 18.5523 19 18V8C19 7.44772 18.5523 7 18 7H6Z" />
      </svg>
    )
  }

  if (kind === 'team') {
    return (
      <svg className="reference-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 21a8 8 0 0 0-16 0" />
        <circle cx="10" cy="8" r="5" />
        <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
      </svg>
    )
  }

  if (kind === 'connector') {
    return (
      <svg className="reference-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 7H7a5 5 0 0 0 0 10h2" />
        <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
        <path d="M8 12h8" />
      </svg>
    )
  }

  if (kind === 'user') {
    return (
      <svg className="reference-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    )
  }

  return (
    <svg className="reference-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  )
}

export type { ReferenceTagKind, ReferenceTagProps } from './types'
