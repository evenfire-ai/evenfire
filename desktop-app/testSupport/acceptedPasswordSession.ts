import type { AppService } from '../src/appService.js'
import type { TokenStore } from '../src/tokenStore.js'
import type { LoginResult, SessionMe } from '../src/types.js'
import { testSessionMe, testSessionTokenForIdentity } from './authTestFixtures.js'

type AcceptedPasswordSessionOptions = {
  token?: string
  me?: Partial<SessionMe>
}

/** Establish a real AppService password session using synthetic auth and isolated TokenStore data. */
export async function establishAcceptedPasswordSession(
  service: AppService,
  options: AcceptedPasswordSessionOptions = {}
): Promise<LoginResult> {
  const me = testSessionMe(options.me)
  const result: LoginResult = {
    token: options.token ?? testSessionTokenForIdentity(me.id, me.teamId),
    me,
  }
  const authClient = (
    service as unknown as {
      authClient: {
        passwordLogin: (email: string, password: string) => Promise<LoginResult>
        getMe: (token: string) => Promise<SessionMe>
      }
    }
  ).authClient
  authClient.passwordLogin = async () => result
  authClient.getMe = async () => me
  await service.passwordLogin(me.email, 'synthetic-password')
  return result
}

/** Persist a current-protocol session through the real password producer for restart fixtures. */
export async function persistAcceptedPasswordSession(options: {
  tokenStore: TokenStore
  userDataDirectory: string
  token?: string
  me?: Partial<SessionMe>
}): Promise<LoginResult> {
  const { AppService } = await import('../src/appService.js')
  const service = new AppService({
    tokenStore: options.tokenStore,
    getUserDataDirectory: () => options.userDataDirectory,
  })
  // These restart fixtures exercise persistence and restore under the already selected
  // environment. Runtime discovery is tested by the fixture's primary AppService instance.
  ;(
    service as unknown as { resolveRuntimeConfigIfNeeded: () => Promise<void> }
  ).resolveRuntimeConfigIfNeeded = async () => undefined
  return establishAcceptedPasswordSession(service, options)
}
