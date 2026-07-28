export type InitialProtocolUrls = {
  evenfireUrls: string[]
  clerumUrls: string[]
}

export function collectInitialProtocolUrls(argv: string[]): InitialProtocolUrls {
  return {
    evenfireUrls: [...new Set(argv.filter(argument => argument.startsWith('evenfire:')))],
    clerumUrls: [...new Set(argv.filter(argument => argument.startsWith('clerum:')))],
  }
}
