import { parseSandboxUiDeepLink } from './sandboxUiDeepLinks.js'

export function shouldAcceptSandboxUiProtocolLink(rawUrl: string): boolean {
  return parseSandboxUiDeepLink(rawUrl) !== null
}
