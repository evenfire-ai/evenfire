import { CLERUM_OAUTH_PROTOCOL, SANDBOX_UI_DEEP_LINK_PROTOCOL } from '@clerum/desktop-app-links'

/** Development instances must be able to leave machine-wide URL ownership alone. */
export function shouldRegisterOsProtocols(argv: string[], isPackaged: boolean): boolean {
  if (!argv.includes('--no-os-protocol-registration')) return true
  if (isPackaged) throw new Error('Protocol registration opt-out is development-only')
  return false
}

export type InitialProtocolUrls = {
  evenfireUrls: string[]
  clerumUrls: string[]
}

export function collectInitialProtocolUrls(argv: string[]): InitialProtocolUrls {
  const hasProtocol = (argument: string, protocol: string) =>
    argument.slice(0, protocol.length).toLowerCase() === protocol
  return {
    evenfireUrls: [
      ...new Set(argv.filter(argument => hasProtocol(argument, SANDBOX_UI_DEEP_LINK_PROTOCOL))),
    ],
    clerumUrls: [...new Set(argv.filter(argument => hasProtocol(argument, CLERUM_OAUTH_PROTOCOL)))],
  }
}
