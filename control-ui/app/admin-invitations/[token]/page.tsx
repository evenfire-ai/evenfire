import Image from 'next/image'
import { createControlAdminInvitationCsrfToken } from '@lib/controlAdminCsrf'
import { validateControlAdminInvitationServer } from '@lib/controlAdminPublicServerApi'
import { AdminInvitationForm } from './AdminInvitationForm'

interface AdminInvitationPageProps {
  params: Promise<{ token?: string }>
  searchParams: Promise<{
    error?: string
    field?: string
    username?: string
    separateDesktopPassword?: string
  }>
}

export default async function AcceptControlAdminInvitationPage({
  params,
  searchParams,
}: AdminInvitationPageProps) {
  const { token: rawToken } = await params
  const query = await searchParams
  const token = String(rawToken || '')
  let email = ''
  let pageError = ''
  const formError = String(query.error || '')
  const formErrorField = String(query.field || '')
  const initialUsername = String(query.username || '')
  const initialUseSameMemberPassword = query.separateDesktopPassword === 'true' ? false : true
  let csrfToken = ''
  let desktopAccess: Awaited<
    ReturnType<typeof validateControlAdminInvitationServer>
  >['desktopAccess'] = null

  if (!token) {
    pageError = 'Invitation token is missing.'
  } else {
    try {
      const response = await validateControlAdminInvitationServer(token)
      email = response.email
      desktopAccess = response.desktopAccess || null
      csrfToken = createControlAdminInvitationCsrfToken(token)
    } catch (validateError) {
      pageError =
        validateError instanceof Error ? validateError.message : 'Failed to open admin invitation'
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
            <h1 className="cu-sidebar__title cu-sidebar__title--page">Become an admin</h1>
          </div>
          <p className="cu-code-hint">
            Set your Control UI username and password to finish accepting this invitation.
            {desktopAccess ? ' This invitation also includes Desktop App access.' : ''}
          </p>

          {pageError ? <div className="cu-banner cu-banner--error">{pageError}</div> : null}
          {!pageError && email ? (
            <AdminInvitationForm
              csrfToken={csrfToken}
              desktopTeams={desktopAccess?.teams || []}
              email={email}
              hasDesktopAccess={Boolean(desktopAccess)}
              initialError={formError}
              initialErrorField={formErrorField}
              initialUsername={initialUsername}
              initialUseSameMemberPassword={initialUseSameMemberPassword}
              token={token}
            />
          ) : null}
        </div>
      </div>
    </main>
  )
}
