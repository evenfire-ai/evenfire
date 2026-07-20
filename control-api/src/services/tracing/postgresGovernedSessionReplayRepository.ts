import type { DbClient } from '../../db.js'
import { PostgresGovernedSessionDetailRepository } from './postgresGovernedSessionDetailRepository.js'
import {
  PostgresGovernedSessionListRepository,
  type SessionPageAnchor,
  type SessionReplayFilters,
} from './postgresGovernedSessionListRepository.js'

export type {
  SessionPageAnchor,
  SessionReplayFilters,
  SessionRepositoryPage,
} from './postgresGovernedSessionListRepository.js'

export class PostgresGovernedSessionReplayRepository {
  private readonly listRepository: PostgresGovernedSessionListRepository
  private readonly detailRepository: PostgresGovernedSessionDetailRepository

  constructor(db: DbClient) {
    this.listRepository = new PostgresGovernedSessionListRepository(db)
    this.detailRepository = new PostgresGovernedSessionDetailRepository(db)
  }

  captureHighWatermark() {
    return this.listRepository.captureHighWatermark()
  }

  list(params: {
    filters: SessionReplayFilters
    highWatermark: string
    after: SessionPageAnchor | null
    limit: number
    promptState: 'enabled' | 'disabled' | 'unavailable'
  }) {
    return this.listRepository.list(params)
  }

  readRuns(hostRef: string, sessionId: string, highWatermark: string) {
    return this.detailRepository.readRuns(hostRef, sessionId, highWatermark)
  }

  readTools(hostRef: string, sessionId: string, highWatermark: string) {
    return this.detailRepository.readTools(hostRef, sessionId, highWatermark)
  }

  readApprovals(
    hostRef: string,
    sessionId: string,
    highWatermark: string,
    promptState: 'enabled' | 'disabled' | 'unavailable'
  ) {
    return this.detailRepository.readApprovals(hostRef, sessionId, highWatermark, promptState)
  }

  readInteractions(params: {
    hostRef: string
    sessionId: string
    highWatermark: string
    after: string
    limit: number
  }) {
    return this.detailRepository.readInteractions(params)
  }

  readTokenUsagePoints(hostRef: string, sessionId: string, highWatermark: string) {
    return this.detailRepository.readTokenUsagePoints(hostRef, sessionId, highWatermark)
  }
}
