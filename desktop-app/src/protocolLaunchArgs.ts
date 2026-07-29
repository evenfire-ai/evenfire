import { CLERUM_OAUTH_PROTOCOL, SANDBOX_UI_DEEP_LINK_PROTOCOL } from '@clerum/desktop-app-links'

export type InitialProtocolUrls = {
  evenfireUrls: string[]
  clerumUrls: string[]
}

export function collectInitialProtocolUrls(argv: string[]): InitialProtocolUrls {
  return {
    evenfireUrls: [
      ...new Set(argv.filter(argument => argument.startsWith(SANDBOX_UI_DEEP_LINK_PROTOCOL))),
    ],
    clerumUrls: [...new Set(argv.filter(argument => argument.startsWith(CLERUM_OAUTH_PROTOCOL)))],
  }
}
