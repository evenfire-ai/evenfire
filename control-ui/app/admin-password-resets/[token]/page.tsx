import Image from 'next/image'
import { createControlAdminPasswordResetCsrfToken } from '@lib/controlAdminCsrf'
import { validateControlAdminPasswordResetServer } from '@lib/controlAdminPublicServerApi'

interface AdminPasswordResetPageProps {
  params: Promise<{ token?: string }>
  searchParams: Promise<{ error?: string }>
}

export default async function ControlAdminPasswordResetPage({
  params,
  searchParams,
}: AdminPasswordResetPageProps) {
  const { token: rawToken } = await params
  const query = await searchParams
  const token = String(rawToken || '')
  let email = ''
  let error = String(query.error || '')

  if (!token && !error) {
    error = 'Password reset token is missing.'
  } else {
    try {
      const response = await validateControlAdminPasswordResetServer(token)
      email = response.email
    } catch (validateError) {
      if (!error) {
        error =
          validateError instanceof Error ? validateError.message : 'Failed to open password reset'
      }
    }
  }

  const csrfToken = !error && email ? createControlAdminPasswordResetCsrfToken(token) : ''

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
            <h1 className="cu-sidebar__title cu-sidebar__title--page">Reset password</h1>
          </div>
          <p className="cu-code-hint">Choose a new password for your Control UI admin account.</p>

          {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          {!error && email ? (
            <form
              method="post"
              action={`/admin-password-resets/${encodeURIComponent(token)}/complete`}
            >
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <div className="cu-admin-invite-email">
                <span className="cu-settings-row__label">Email</span>
                <span className="cu-settings-row__value">{email}</span>
              </div>
              <div className="cu-field">
                <label htmlFor="control-admin-reset-password">
                  Password<span className="cu-field__required"> *</span>
                </label>
                <input
                  id="control-admin-reset-password"
                  name="password"
                  className="cu-input"
                  type="password"
                  autoComplete="new-password"
                />
              </div>
              <div className="cu-field">
                <label htmlFor="control-admin-reset-password-confirm">
                  Confirm password<span className="cu-field__required"> *</span>
                </label>
                <input
                  id="control-admin-reset-password-confirm"
                  name="confirmPassword"
                  className="cu-input"
                  type="password"
                  autoComplete="new-password"
                />
              </div>
              <button
                type="submit"
                className="cu-btn cu-btn--primary cu-btn--block cu-login-submit"
              >
                Set new password
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </main>
  )
}
