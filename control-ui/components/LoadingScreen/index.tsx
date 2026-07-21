import Image from 'next/image'

export function LoadingScreen() {
  return (
    <main className="cu-loading-screen">
      <section
        className="cu-loading-screen__surface"
        role="status"
        aria-label="Loading Control UI"
        aria-live="polite"
      >
        <div className="cu-loading-screen__brand">
          <Image
            className="cu-loading-screen__mark"
            src="/brand/logo.svg"
            alt=""
            width={44}
            height={44}
            aria-hidden="true"
            priority
          />
          <span className="cu-loading-screen__brand-copy">
            <span className="cu-loading-screen__title">Evenfire</span>
            <span className="cu-loading-screen__subtitle">Control UI</span>
          </span>
        </div>
        <div className="cu-loading-screen__progress" aria-hidden="true" />
        <p className="cu-loading-screen__status">Loading session…</p>
      </section>
    </main>
  )
}
