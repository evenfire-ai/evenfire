import { notFound } from 'next/navigation'

/**
 * `PROFILE_ROUTES.desktopLogin`, which Desktop opens to sign in. It renders Profile UI's
 * not-found page until the Desktop sign-in page itself replaces this file.
 */
export default function DesktopLoginPage(): never {
  notFound()
}
