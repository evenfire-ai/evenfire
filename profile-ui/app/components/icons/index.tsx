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

export function IconExternalLink({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M14 3h7v7m0-7-11 11m8-2v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconX({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M18 6 6 18M6 6l12 12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconSend({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="m22 2-11 11M22 2 15 22l-4-9-9-4Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconLayers({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="m12 2 9 5-9 5-9-5 9-5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="m3 12 9 5 9-5m-18 5 9 5 9-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconChatBubble({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconBot({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <rect
        x="4"
        y="9"
        width="16"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 9V4m-4 8h.01M16 12h.01M9 17h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="3" r="1" fill="currentColor" />
    </svg>
  )
}

export function IconCode({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="m16 18 6-6-6-6M8 6l-6 6 6 6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconTimer({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M10 2h4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle
        cx="12"
        cy="14"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 14v-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function IconShieldCheck({ height = 16, width = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="m9 12 2 2 4-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

// Telegram brand logo. Rendered instances share one gradient definition id,
// which is safe because every instance defines the identical gradient.
export function IconTelegram({ className, height = 16, width = 16 }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="cu-telegram-gradient"
          x1="256"
          x2="256"
          y1="2"
          y2="514"
          gradientTransform="matrix(1 0 0 -1 0 514)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1d93d2" />
          <stop offset="1" stopColor="#38b0e3" />
        </linearGradient>
      </defs>
      <circle cx="256" cy="256" r="256" fill="url(#cu-telegram-gradient)" />
      <path
        d="m173.3 274.7 30.4 84.1s3.8 7.9 7.9 7.9 64.5-62.9 64.5-62.9l67.3-129.9-169 79.1z"
        fill="#c8daea"
      />
      <path d="m213.6 296.3-5.8 62s-2.4 19 16.5 0c19-19 37.2-33.6 37.2-33.6" fill="#a9c6d8" />
      <path
        d="m173.8 277.7-62.5-20.4s-7.5-3-5.1-9.9c.5-1.4 1.5-2.6 4.5-4.7C124.6 233.1 367 146 367 146s6.8-2.3 10.9-.8c2 .6 3.6 2.3 4 4.4.4 1.8.6 3.7.5 5.5 0 1.6-.2 3.1-.4 5.4-1.5 23.8-45.7 201.6-45.7 201.6s-2.6 10.4-12.1 10.8c-4.7.2-9.3-1.6-12.6-4.9-18.6-16-82.8-59.2-97-68.6-.6-.4-1.1-1.1-1.2-1.9-.2-1 .9-2.2.9-2.2s111.8-99.4 114.8-109.8c.2-.8-.6-1.2-1.8-.9-7.4 2.7-136.2 84.1-150.4 93-.9.2-2 .3-3.1.1"
        fill="#fff"
      />
    </svg>
  )
}

// Slack brand logo.
export function IconSlack({ className, height = 16, width = 16 }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <path
        d="M107.9 323.6c0 29.7-24 53.8-53.8 53.8S.3 353.4.3 323.6c0-29.7 24-53.8 53.8-53.8h53.8zm26.9 0c0-29.7 24-53.8 53.8-53.8s53.8 24 53.8 53.8V458c0 29.7-24 53.8-53.8 53.8s-53.8-24-53.8-53.8z"
        fill="#e01e5a"
      />
      <path
        d="M188.6 107.7c-29.7 0-53.8-24-53.8-53.8S158.8.1 188.6.1s53.8 24 53.8 53.8v53.8zm0 27.3c29.7 0 53.8 24 53.8 53.8s-24 53.8-53.8 53.8H53.8C24 242.6 0 218.5 0 188.8S24 135 53.8 135z"
        fill="#36c5f0"
      />
      <path
        d="M404.1 188.8c0-29.7 24-53.8 53.8-53.8s53.8 24 53.8 53.8-24 53.8-53.8 53.8h-53.8zm-26.9 0c0 29.7-24 53.8-53.8 53.8-29.7 0-53.8-24-53.8-53.8V54c0-29.7 24-53.8 53.8-53.8s53.8 24 53.8 53.8z"
        fill="#2eb67d"
      />
      <path
        d="M323.4 404.3c29.7 0 53.8 24 53.8 53.8 0 29.7-24 53.8-53.8 53.8-29.7 0-53.8-24-53.8-53.8v-53.8zm0-26.9c-29.7 0-53.8-24-53.8-53.8s24-53.8 53.8-53.8h134.8c29.7 0 53.8 24 53.8 53.8 0 29.7-24 53.8-53.8 53.8z"
        fill="#ecb22e"
      />
    </svg>
  )
}

// Robot face used for agent subjects, matching Control UI's GFS subject picker.
export function IconRobot({ className, height = 16, width = 16 }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M13.5 2C13.5 2.44425 13.3069 2.84339 13 3.11805V5H18C19.6569 5 21 6.34315 21 8V18C21 19.6569 19.6569 21 18 21H6C4.34315 21 3 19.6569 3 18V8C3 6.34315 4.34315 5 6 5H11V3.11805C10.6931 2.84339 10.5 2.44425 10.5 2C10.5 1.17157 11.1716 0.5 12 0.5C12.8284 0.5 13.5 1.17157 13.5 2ZM6 7C5.44772 7 5 7.44772 5 8V18C5 18.5523 5.44772 19 6 19H18C18.5523 19 19 18.5523 19 18V8C19 7.44772 18.5523 7 18 7H13H11H6ZM2 10H0V16H2V10ZM22 10H24V16H22V10ZM9 14.5C9.82843 14.5 10.5 13.8284 10.5 13C10.5 12.1716 9.82843 11.5 9 11.5C8.17157 11.5 7.5 12.1716 7.5 13C7.5 13.8284 8.17157 14.5 9 14.5ZM15 14.5C15.8284 14.5 16.5 13.8284 16.5 13C16.5 12.1716 15.8284 11.5 15 11.5C14.1716 11.5 13.5 12.1716 13.5 13C13.5 13.8284 14.1716 14.5 15 14.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
