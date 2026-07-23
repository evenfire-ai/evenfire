export type InitialProtocolUrls = {
  evenfireUrls: string[]
  clerumUrl?: string
}

export function collectInitialProtocolUrls(argv: string[]): InitialProtocolUrls {
  return {
    evenfireUrls: [...new Set(argv.filter(argument => argument.startsWith('evenfire://')))],
    clerumUrl: argv.find(argument => argument.startsWith('clerum://')),
  }
}
