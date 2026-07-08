import Image from 'next/image'
import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="cu-app cu-app--auth cu-not-found">
      <section className="cu-card cu-not-found__card" aria-labelledby="cu-not-found-title">
        <div className="cu-card__body cu-not-found__body">
          <Image
            className="cu-not-found__brand-mark"
            src="/brand/logo.svg"
            alt=""
            width={56}
            height={56}
            priority
            aria-hidden="true"
          />
          <p className="cu-not-found__eyebrow">404</p>
          <h1 id="cu-not-found-title" className="cu-not-found__title">
            Page not found
          </h1>
          <p className="cu-not-found__copy">
            This Profile UI route is not available. Return home to continue from your profile.
          </p>
          <Link className="cu-btn cu-btn--primary cu-not-found__button" href="/">
            Back to Profile UI
          </Link>
        </div>
      </section>
    </main>
  )
}
