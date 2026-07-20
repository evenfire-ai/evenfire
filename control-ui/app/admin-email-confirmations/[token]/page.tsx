import Image from 'next/image'
import { CONTROL_ROUTES } from '@constants/routes'
import { completeControlAdminEmailConfirmationServer } from '@lib/controlAdminPublicServerApi'

interface AdminEmailConfirmationPageProps {
  params: Promise<{ token?: string }>
}

export default async function ConfirmControlAdminEmailPage({
  params,
}: AdminEmailConfirmationPageProps) {
  const { token: rawToken } = await params
  const token = String(rawToken || '')
  let error = ''
  let confirmationState = ''

  if (!token) {
    error = 'Confirmation token is missing.'
  } else {
    try {
      const response = await completeControlAdminEmailConfirmationServer(token)
      confirmationState = response.alreadyConfirmed ? 'already' : 'confirmed'
    } catch (confirmationError) {
      error =
        confirmationError instanceof Error
          ? confirmationError.message
          : 'Failed to confirm email address'
    }
  }

  return (
    <main className="cu-app cu-app--auth">
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
            <h1 className="cu-sidebar__title cu-sidebar__title--page">Confirm your email</h1>
          </div>
          <p className="cu-code-hint">Confirming this address for your Control UI admin account.</p>

          {confirmationState === 'confirmed' ? (
            <div className="cu-banner cu-banner--ok">Email confirmed.</div>
          ) : null}
          {confirmationState === 'already' ? (
            <div className="cu-banner cu-banner--info">Email already confirmed.</div>
          ) : null}
          {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          <a
            className="cu-btn cu-btn--primary cu-btn--block cu-login-submit"
            href={CONTROL_ROUTES.settings.root}
          >
            Return to settings
          </a>
        </div>
      </div>
    </main>
  )
}
