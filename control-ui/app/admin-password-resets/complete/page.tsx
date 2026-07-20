import Image from 'next/image'
import { CONTROL_ROUTES } from '@constants/routes'
import { ClearAdminToken } from './ClearAdminToken'

interface AdminPasswordResetCompletePageProps {
  searchParams: Promise<{ login?: string }>
}

export default async function AdminPasswordResetCompletePage({
  searchParams,
}: AdminPasswordResetCompletePageProps) {
  const params = await searchParams
  const login = String(params.login || '')
  const loginHref = CONTROL_ROUTES.loginWith({ login })

  return (
    <main className="cu-app cu-app--auth">
      <ClearAdminToken />
      <div className="cu-card cu-card--auth cu-admin-invite-card">
        <div className="cu-card__body">
          <div className="cu-login-brand">
            <Image
              className="cu-sidebar__brand-mark cu-sidebar__brand-mark--light"
              src="/brand/logotype-light.svg"
              alt=""
              width={184}
              height={44}
              aria-hidden="true"
            />
            <Image
              className="cu-sidebar__brand-mark cu-sidebar__brand-mark--dark"
              src="/brand/logotype-dark.svg"
              alt="Evenfire"
              width={184}
              height={44}
            />
            <h1 className="cu-sidebar__title cu-sidebar__title--page">Password updated</h1>
          </div>
          <p className="cu-code-hint">Your Control UI admin password has been reset.</p>
          <a className="cu-btn cu-btn--primary cu-btn--block cu-login-submit" href={loginHref}>
            Go to sign in
          </a>
        </div>
      </div>
    </main>
  )
}
