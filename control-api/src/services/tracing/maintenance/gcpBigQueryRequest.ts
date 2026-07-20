import { GoogleAuth } from 'google-auth-library'

const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly'
const STATIC_GOOGLE_CREDENTIAL_ENV = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_CLOUD_KEYFILE_JSON',
] as const

export type BigQueryAuthorizedRequester = (input: {
  url: string
  body: Record<string, unknown>
  timeoutMs: number
}) => Promise<unknown>

export function assertWorkloadIdentityCredentialSource(env: NodeJS.ProcessEnv): void {
  const configured = STATIC_GOOGLE_CREDENTIAL_ENV.find(name => Boolean(env[name]?.trim()))
  if (configured) {
    throw new Error(`${configured} is forbidden for governed tracing GCP imports`)
  }
}

export async function googleAuthorizedBigQueryRequest(input: {
  url: string
  body: Record<string, unknown>
  timeoutMs: number
}): Promise<unknown> {
  const auth = new GoogleAuth({ scopes: [BIGQUERY_SCOPE] })
  const response = await auth.request<unknown>({
    url: input.url,
    method: 'POST',
    data: input.body,
    timeout: input.timeoutMs,
  })
  return response.data
}
