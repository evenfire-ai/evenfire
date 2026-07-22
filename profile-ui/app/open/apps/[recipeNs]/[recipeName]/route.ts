import {
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

  return new Response(buildEvenfireDesktopAppRedirectDocument(deepLink), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
