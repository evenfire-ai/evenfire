import Image from 'next/image'
import { ClearAdminToken } from './ClearAdminToken'

interface AdminInvitationSetupCompletePageProps {
  searchParams: Promise<{ login?: string }>
}

export default async function AdminInvitationSetupCompletePage({
  searchParams,
}: AdminInvitationSetupCompletePageProps) {
  const params = await searchParams
  const login = String(params.login || '')
  const loginHref = login ? `/?login=${encodeURIComponent(login)}` : '/'

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
            <h1 className="cu-sidebar__title cu-sidebar__title--page">Admin setup complete</h1>
          </div>
          <p className="cu-code-hint">Your Control UI admin account is ready.</p>
          <a className="cu-btn cu-btn--primary cu-btn--block cu-login-submit" href={loginHref}>
            Go to sign in
          </a>
        </div>
      </div>
    </main>
  )
}
