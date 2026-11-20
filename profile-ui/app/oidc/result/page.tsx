import Image from 'next/image'
import Link from 'next/link'
import { OIDC_GENERIC_RESULT_MESSAGE, OIDC_REFUSAL_MESSAGES } from '@constants/oidc'
import { PROFILE_ROUTES } from '@constants/routes'
import { OIDC_REFUSAL_REASONS, type OidcRefusalReason } from '../../api/oidc/types'

type OidcResultPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function messageForReason(reason: string | string[] | undefined): string {
  return typeof reason === 'string' && (OIDC_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? OIDC_REFUSAL_MESSAGES[reason as OidcRefusalReason]
    : OIDC_GENERIC_RESULT_MESSAGE
}

export default async function OidcResultPage({ searchParams }: OidcResultPageProps) {
  const { reason } = await searchParams
  return (
    <main className="cu-app cu-app--auth">
      <div className="cu-card cu-card--auth">
        <div className="cu-card__body">
          <div className="cu-login-brand">
            <Image
              className="cu-sidebar__brand-mark"
              src="/brand/logo.svg"
              alt=""
              width={44}
              height={44}
              aria-hidden="true"
            />
            <div className="cu-sidebar__brand-copy">
              <h1 className="cu-sidebar__title">Evenfire</h1>
              <p className="cu-sidebar__subtitle">Profile Portal</p>
            </div>
          </div>
          <h1 className="page-title">Sign-in unsuccessful</h1>
          <div className="message message--error-plain" role="alert">
            {messageForReason(reason)}
          </div>
          <div className="cu-auth-return-link">
            <Link className="text-link" href={PROFILE_ROUTES.root}>
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </main>
  )
}
