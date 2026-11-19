import type { GfsWatchClient } from '../../../../src/gfs/watchClient.js'
import type { SessionMe, SessionState } from '../../../../src/types.js'
import type { FakeOwner } from '../../../../testSupport/gfsWatch/fakeOwner.js'

/**
 * Main's watch test harnesses, loaded at run time only. Their fake server
 * checks request bodies with control-api's own key parser, and a static import
 * would pull control-api's server modules (express, pg, its config) into the
 * renderer's type program. These are the parts the renderer suites use.
 */
export interface WatchServerLike {
  baseUrl: string
  gets: Array<{ keys: string[]; token: string }>
  puts: Array<{ keys: string[]; token: string }>
  current(): { keys: Set<string> } | undefined
  openStreams(): unknown[]
  frame(frame: Record<string, unknown>): void
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WatchHarnessLike {
  client: GfsWatchClient
  server: WatchServerLike
  owners: Map<number, FakeOwner>
  start(): Promise<WatchHarnessLike>
  stop(): Promise<void>
  login(userId?: string, authGeneration?: number, teamId?: string | null): Promise<string>
  publish(token: string | null): Promise<void>
  owner(id?: number): FakeOwner
  subscribe(keys: string[], id?: number, userId?: string): Promise<{ sessionExpired: boolean }>
  settle(maxMs?: number): Promise<void>
  fireNext(): Promise<unknown>
}

export interface AppServiceLike {
  sessionToken: string | null
  getSessionState(): Promise<SessionState>
  getSessionGeneration(): number
  logout(): Promise<unknown>
  switchTeam(teamId: string): Promise<unknown>
  applyRuntimeEnvironmentChange(op: () => Promise<void>): Promise<number>
}

export interface AppServiceWatchHarnessLike {
  server: WatchServerLike
  service: AppServiceLike
  client: GfsWatchClient
  owners: Map<number, FakeOwner>
  onSessionCleared: { mockImplementation(fn: () => void): unknown }
  meAnswer: (token: string) => Promise<SessionMe>
  start(): Promise<AppServiceWatchHarnessLike>
  stop(): Promise<void>
  login(token: string, me?: SessionMe): Promise<SessionState>
  settle(maxMs?: number): Promise<void>
}

const WATCH_HARNESS = '../../../../testSupport/gfsWatch/watchHarness.js'
const APP_SERVICE_HARNESS = '../../../../testSupport/gfsWatch/appServiceHarness.js'
const FAKE_WATCH_SERVER = '../../../../testSupport/gfsWatch/fakeWatchServer.js'

export async function newWatchHarness(): Promise<WatchHarnessLike> {
  const module = (await import(/* @vite-ignore */ WATCH_HARNESS)) as {
    WatchHarness: new () => WatchHarnessLike
  }
  return new module.WatchHarness()
}

export async function newAppServiceWatchHarness(): Promise<AppServiceWatchHarnessLike> {
  const module = (await import(/* @vite-ignore */ APP_SERVICE_HARNESS)) as {
    AppServiceWatchHarness: new () => AppServiceWatchHarnessLike
  }
  return new module.AppServiceWatchHarness()
}

export async function newWatchServer(): Promise<WatchServerLike> {
  const module = (await import(/* @vite-ignore */ FAKE_WATCH_SERVER)) as {
    FakeWatchServer: new () => WatchServerLike
  }
  return new module.FakeWatchServer()
}
