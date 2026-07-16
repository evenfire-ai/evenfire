type IconProps = {
  className?: string
  height?: number
  width?: number
}

export function IconRefresh({ className, height = 18, width = 18 }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M20 11a8 8 0 0 0-14.2-5M4 5v5h5M4 13a8 8 0 0 0 14.2 5M20 19v-5h-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconTrash({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M3 6h18M8 6V4h8v2m-10 0 1 14h10l1-14"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconPencil({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M17 3a2.85 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="m15 5 4 4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconAlertTriangle({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M12 3 2.5 20h19L12 3Zm0 6v5m0 3h.01"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconCopy({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <rect
        x="8"
        y="8"
        width="12"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}
