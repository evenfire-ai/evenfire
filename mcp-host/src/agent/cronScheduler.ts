/**
 * Cron Scheduler
 * 
 * Manages scheduled tasks that can be created by the agent.
 * Uses cron expressions to schedule recurring tasks.
 */

import { EventEmitter } from "events";
import { CronJob } from "./types";
import { MessageQueue, Task } from "../queue";
import { v4 as uuidv4 } from "uuid";
import { CronExpressionParser } from "cron-parser";

// Maximum safe delay for setTimeout (2^31 - 1 ms ≈ 24.8 days).
// Exceeding this causes Node.js to silently set the timeout to 1ms.
const MAX_SAFE_TIMEOUT = 2_147_483_647;

// Parse a cron expression and get the next run time using cron-parser library.
// Supports standard 5-field cron format: minute hour day month weekday
function parseNextRun(schedule: string, from: Date = new Date()): Date | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    console.error(`[Cron] Invalid cron expression: ${schedule}`);
    return null;
  }
  try {
    const interval = CronExpressionParser.parse(schedule, {
      currentDate: from,
    });
    return interval.next().toDate();
  } catch (error) {
    console.error(`[Cron] Invalid cron expression: ${schedule}`, error);
    return null;
  }
}

/**
 * Cron Scheduler for managing scheduled tasks.
 */
export class CronScheduler extends EventEmitter {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private queue: MessageQueue;
  private isRunning: boolean = false;

  constructor(queue: MessageQueue) {
    super();
    this.queue = queue;
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.isRunning) return;

    console.log("[Cron] Starting scheduler");
    this.isRunning = true;

    // Schedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    console.log("[Cron] Stopping scheduler");
    this.isRunning = false;

    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Create a new cron job.
   */
  createJob(
    name: string,
    schedule: string,
    task: string,
    createdBy?: string,
    origin?: CronJob["origin"],
  ): CronJob | null {
    // Validate schedule
    const nextRun = parseNextRun(schedule);
    if (!nextRun) {
      console.error(`[Cron] Invalid schedule: ${schedule}`);
      return null;
    }

    const job: CronJob = {
      id: uuidv4(),
      name,
      schedule,
      task,
      enabled: true,
      nextRun,
      createdAt: new Date(),
      createdBy,
      origin,
    };

    this.jobs.set(job.id, job);
    console.log(`[Cron] Created job: ${name} (${job.id}) - Schedule: ${schedule}`);
    console.log(`[Cron]   Next run: ${nextRun.toISOString()}`);

    // Schedule if running
    if (this.isRunning) {
      this.scheduleJob(job);
    }

    this.emit("cron:created", job);
    return job;
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): CronJob | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get all jobs.
   */
  getAllJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Enable a job.
   */
  enableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.enabled = true;
    if (this.isRunning) {
      this.scheduleJob(job);
    }

    console.log(`[Cron] Enabled job: ${job.name} (${jobId})`);
    return true;
  }

  /**
   * Disable a job.
   */
  disableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.enabled = false;

    // Clear timer
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }

    console.log(`[Cron] Disabled job: ${job.name} (${jobId})`);
    return true;
  }

  /**
   * Delete a job.
   */
  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Clear timer
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }

    this.jobs.delete(jobId);
    console.log(`[Cron] Deleted job: ${job.name} (${jobId})`);

    this.emit("cron:deleted", job);
    return true;
  }

  /**
   * Update a job.
   */
  updateJob(
    jobId: string,
    updates: Partial<Pick<CronJob, "name" | "schedule" | "task">>
  ): CronJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (updates.name) job.name = updates.name;
    if (updates.task) job.task = updates.task;
    
    if (updates.schedule) {
      const nextRun = parseNextRun(updates.schedule);
      if (!nextRun) {
        console.error(`[Cron] Invalid schedule: ${updates.schedule}`);
        return null;
      }
      job.schedule = updates.schedule;
      job.nextRun = nextRun;
    }

    // Reschedule if running and enabled
    if (this.isRunning && job.enabled) {
      const timer = this.timers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(jobId);
      }
      this.scheduleJob(job);
    }

    console.log(`[Cron] Updated job: ${job.name} (${jobId})`);
    return job;
  }

  /**
   * Manually trigger a job.
   */
  triggerJob(jobId: string): Task | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    console.log(`[Cron] Manually triggering job: ${job.name} (${jobId})`);
    return this.executeJob(job);
  }

  /**
   * Schedule a job to run at its next scheduled time.
   */
  private scheduleJob(job: CronJob): void {
    if (!job.enabled || !job.nextRun) return;

    const now = Date.now();
    const runAt = job.nextRun.getTime();
    const delay = Math.max(0, runAt - now);

    console.log(`[Cron] Scheduling job: ${job.name} in ${Math.round(delay / 1000)}s`);

    // Guard against setTimeout overflow: delays > 2^31-1 ms cause Node.js
    // to silently set the timeout to 1ms, creating a runaway infinite loop.
    // Use a relay timer that wakes up at the safe max and re-checks.
    if (delay > MAX_SAFE_TIMEOUT) {
      console.log(`[Cron] Delay exceeds setTimeout max (${Math.round(delay / 86_400_000)}d), using relay timer for ${job.name}`);
      const timer = setTimeout(() => {
        if (job.enabled && job.nextRun) {
          this.scheduleJob(job);
        }
      }, MAX_SAFE_TIMEOUT);
      this.timers.set(job.id, timer);
      return;
    }

    const timer = setTimeout(() => {
      this.executeJob(job);

      // Schedule next run — advance "from" by 60s to avoid re-firing
      // within the same cron minute window (setTimeout can fire slightly early).
      const afterExecution = new Date(Date.now() + 60_000);
      job.nextRun = parseNextRun(job.schedule, afterExecution) ?? undefined;
      if (job.nextRun && job.enabled) {
        this.scheduleJob(job);
      }
    }, delay);

    this.timers.set(job.id, timer);
  }

  /**
   * Execute a scheduled job.
   */
  private executeJob(job: CronJob): Task {
    console.log(`[Cron] Executing job: ${job.name} (${job.id})`);
    job.lastRun = new Date();

    // Create a task and add to queue
    const task = this.queue.createTaskFromCron(job.id, job.task, job.origin, "normal");
    this.queue.enqueue(task);

    this.emit("cron:triggered", { job, task });
    return task;
  }

  /**
   * Export jobs to JSON (for persistence).
   */
  exportJobs(): string {
    const jobs = Array.from(this.jobs.values()).map((job) => ({
      ...job,
      lastRun: job.lastRun?.toISOString(),
      nextRun: job.nextRun?.toISOString(),
      createdAt: job.createdAt.toISOString(),
    }));
    return JSON.stringify(jobs, null, 2);
  }

  /**
   * Import jobs from JSON.
   */
  importJobs(json: string): number {
    try {
      const jobs = JSON.parse(json) as CronJob[];
      let imported = 0;

      for (const jobData of jobs) {
        const job: CronJob = {
          ...jobData,
          lastRun: jobData.lastRun ? new Date(jobData.lastRun) : undefined,
          nextRun: jobData.nextRun ? new Date(jobData.nextRun) : undefined,
          createdAt: new Date(jobData.createdAt),
        };

        // Recalculate next run
        job.nextRun = parseNextRun(job.schedule) ?? undefined;

        this.jobs.set(job.id, job);
        if (this.isRunning && job.enabled) {
          this.scheduleJob(job);
        }
        imported++;
      }

      console.log(`[Cron] Imported ${imported} job(s)`);
      return imported;
    } catch (error) {
      console.error("[Cron] Failed to import jobs:", error);
      return 0;
    }
  }
}
