import { randomBytes } from 'node:crypto'
import {
  buildEvenfireDesktopAppContentSecurityPolicy,
  buildEvenfireDesktopAppLink,
  buildEvenfireDesktopAppRedirectDocument,
} from '@lib/desktopAppLinks'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ recipeNs: string; recipeName: string }> }
) {
  const params = await context.params
  const requestUrl = new URL(request.url)
  const deepLink = buildEvenfireDesktopAppLink({
    recipeNs: params.recipeNs,
    recipeName: params.recipeName,
    path: requestUrl.searchParams.get('path') || '/',
    teamId: requestUrl.searchParams.get('team') || undefined,
  })

  if (!deepLink) {
    return new Response('Invalid or incomplete Evenfire desktop app link.', {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    })
  }

  const scriptNonce = randomBytes(18).toString('base64')
  return new Response(buildEvenfireDesktopAppRedirectDocument(deepLink, scriptNonce), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce),
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
