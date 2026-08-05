import { CLERUM_OAUTH_PROTOCOL, SANDBOX_UI_DEEP_LINK_PROTOCOL } from '@clerum/desktop-app-links'

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
