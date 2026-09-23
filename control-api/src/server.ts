import type { Server as HttpServer } from 'node:http'
import { createApp } from './app.js'
import { config } from './config.js'
import { K8sGateway } from './k8s.js'
import { closeActiveEntityChangeStreams } from './routes/entityChangeStream.js'
import {
  startBudgetReservationSweepCron,
  stopBudgetReservationSweepCron,
} from './services/budgetReservationSweepCron.js'
import { stopEntityChangeDispatcher } from './services/entityChangeService.js'
import {
  startPluginWorkloadSdkMaintenanceCron,
  stopPluginWorkloadSdkMaintenanceCron,
} from './services/pluginWorkloadSdkMaintenanceCron.js'
import { startUsageRetentionCron, stopUsageRetentionCron } from './services/usageRetentionCron.js'
import { startUsageRollupCron, stopUsageRollupCron } from './services/usageRollupCron.js'
import { startExpiryCron, stopExpiryCron } from './services/userApprovalRequestExpiryCron.js'

export class ControlApiServer {
  private httpServer: HttpServer | null = null

  constructor(
    private readonly gateway: K8sGateway,
    private readonly port: number
  ) {}

  async start(): Promise<void> {
    const app = createApp(this.gateway)

    startExpiryCron(config.userApprovalRequestExpiryIntervalMs)
    startUsageRollupCron({
      fiveMinIntervalMs: config.usageRollup5MinIntervalMs,
      hourlyIntervalMs: config.usageRollupHourlyIntervalMs,
      dailyIntervalMs: config.usageRollupDailyIntervalMs,
    })
    startUsageRetentionCron(config.usageRetentionIntervalMs)
    startBudgetReservationSweepCron(config.budgetReservationSweepIntervalMs)
    startPluginWorkloadSdkMaintenanceCron()

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(this.port, resolve)
      this.httpServer = server
      server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    stopExpiryCron()
    stopUsageRollupCron()
    stopUsageRetentionCron()
    stopBudgetReservationSweepCron()
    stopPluginWorkloadSdkMaintenanceCron()
    stopEntityChangeDispatcher()
    closeActiveEntityChangeStreams()
    const server = this.httpServer
    this.httpServer = null
    if (!server) return
    const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 5000)
    forceCloseTimer.unref()
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
    clearTimeout(forceCloseTimer)
  }
}
