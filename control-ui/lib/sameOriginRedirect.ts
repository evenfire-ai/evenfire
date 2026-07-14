import { NextResponse } from 'next/server'

export function sameOriginRedirect(location: string, status = 303): NextResponse {
  if (!location.startsWith('/') || location.startsWith('//')) {
    throw new Error('sameOriginRedirect requires a relative same-origin path')
  }

  return new NextResponse(null, {
    status,
    headers: {
      Location: location,
    },
  })
}
