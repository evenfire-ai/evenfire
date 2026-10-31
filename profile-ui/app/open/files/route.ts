import { randomBytes } from 'node:crypto'
import {
  buildEvenfireDesktopAppContentSecurityPolicy,
  buildEvenfireDesktopGfsResourceRedirectDocument,
} from '../../../lib/desktopAppLinks'

export const dynamic = 'force-dynamic'

function invalidLinkResponse(): Response {
  return new Response('Invalid or incomplete EvenDrive resource link.', {
    status: 400,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  if (
    [...requestUrl.searchParams.keys()].some(key => key !== 'uri') ||
    requestUrl.searchParams.getAll('uri').length !== 1
  ) {
    return invalidLinkResponse()
  }

  const uri = requestUrl.searchParams.get('uri') || ''
  let document: string
  try {
    const scriptNonce = randomBytes(18).toString('base64')
    document = buildEvenfireDesktopGfsResourceRedirectDocument(uri, scriptNonce)
    return new Response(document, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce),
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return invalidLinkResponse()
  }
}
