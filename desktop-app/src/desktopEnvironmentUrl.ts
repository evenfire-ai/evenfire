export function canonicalizeDesktopRestEndpoint(rawValue: string): string {
  const url = new URL(rawValue.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Desktop environment URLs must use http(s) without credentials')
  }

  const hostname = url.hostname
  if (!hostname.startsWith('[') && hostname.endsWith('.')) {
    const hostnameWithoutRootDot = hostname.slice(0, -1)
    if (!hostnameWithoutRootDot || hostnameWithoutRootDot.endsWith('.')) {
      throw new Error('Desktop environment REST host is invalid')
    }
    url.hostname = hostnameWithoutRootDot
  }

  const pathname = url.pathname === '/' ? '' : url.pathname
  return `${url.origin}${pathname}${url.search}${url.hash}`
}

export function desktopRestEndpointOrigin(rawValue: string): string {
  return new URL(canonicalizeDesktopRestEndpoint(rawValue)).origin
}

export function sameDesktopRestEndpoint(left: string, right: string): boolean {
  try {
    return canonicalizeDesktopRestEndpoint(left) === canonicalizeDesktopRestEndpoint(right)
  } catch {
    return false
  }
}
