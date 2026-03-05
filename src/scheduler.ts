import crypto from 'crypto';
import { Blackboard } from './blackboard/blackboard.js';
import { ScheduledTask, Task } from './types.js';
import { logger } from './logger.js';

/**
 * Proactive scheduler — posts tasks to the blackboard on cron schedules.
 * Tasks go through the same reactive pipeline: blackboard → runner → agent.
 * No Doorman involvement needed.
 *
 * Supports simple cron: "minute hour dayOfMonth month dayOfWeek"
 * Special shortcuts: "@daily" = "0 9 * * *", "@hourly" = "0 * * * *"
 */
export class Scheduler {
  private schedules: ScheduledTask[];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private blackboard: Blackboard,
    schedules: ScheduledTask[] = [],
  ) {
    this.schedules = schedules.filter(s => s.enabled);
  }

  start(): void {
    if (this.schedules.length === 0) {
      logger.info('No schedules configured');
      return;
    }

    logger.info({ count: this.schedules.length }, 'Scheduler started');

    // Check every 60 seconds
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref(); // don't prevent process exit
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = new Date();

    for (const schedule of this.schedules) {
      if (this.matchesCron(schedule.cron, now)) {
        this.fireSchedule(schedule, now);
      }
    }
  }

  private fireSchedule(schedule: ScheduledTask, now: Date): void {
    // Prevent duplicate fires within the same minute
    if (schedule.lastRunAt) {
      const lastRun = new Date(schedule.lastRunAt);
      if (now.getTime() - lastRun.getTime() < 60_000) return;
    }

    schedule.lastRunAt = now.toISOString();
    logger.info({ scheduleId: schedule.id, prompt: schedule.prompt.slice(0, 80) }, 'Firing scheduled task');

    const task: Task = {
      id: crypto.randomUUID(),
      prompt: schedule.prompt,
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      executor: schedule.executor,
      source: 'scheduler',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.blackboard.createTask(task);
  }

  /**
   * Simple cron matcher. Supports: minute hour dayOfMonth month dayOfWeek
   * Each field: number, * (any), or comma-separated values.
   * Shortcuts: @daily, @hourly, @weekly
   */
  private matchesCron(cron: string, now: Date): boolean {
    let expr = cron.trim();
    if (expr === '@daily') expr = '0 9 * * *';
    if (expr === '@hourly') expr = '0 * * * *';
    if (expr === '@weekly') expr = '0 9 * * 1';

    const parts = expr.split(/\s+/);
    if (parts.length !== 5) return false;

    const fields = [
      now.getMinutes(),
      now.getHours(),
      now.getDate(),
      now.getMonth() + 1,
      now.getDay(),
    ];

    return parts.every((part, i) => {
      if (part === '*') return true;
      const values = part.split(',').map(Number);
      return values.includes(fields[i]);
    });
  }
}
