import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Task, AgentInfo, Skill, AgentRole, FeedEntry, Approval } from '../types.js';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface RunningAgent {
  abort: AbortController;
  timeout: NodeJS.Timeout;
  promise: Promise<void>;
  startedAt: number;
  outputBytes: number;
}

export class AgentRunner {
  private running: Map<string, RunningAgent> = new Map();
  private executors: Map<string, AgentExecutor> = new Map();

  constructor(
    private blackboard: Blackboard,
    private registry: AgentRegistry,
    private skills: Skill[],
  ) {
    // React to new tasks posted on the blackboard
    this.blackboard.on('task:created', () => this.drainPending());
  }

  /**
   * Spawn agents for as many pending tasks as slots allow (FIFO).
   */
  drainPending(): void {
    const pending = this.blackboard.getAllTasks()
      .filter(t => t.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const task of pending) {
      if (!this.registry.canSpawn()) break;
      this.spawnAgent(task);
    }
  }

  /**
   * Register an executor by name. The runner doesn't know how executors work —
   * it only knows the unified interface.
   */
  registerExecutor(executor: AgentExecutor): void {
    this.executors.set(executor.name, executor);
    logger.info({ executor: executor.name }, 'Executor registered');
  }

  async spawnAgent(task: Task): Promise<string | null> {
    // Guard: only spawn pending tasks (prevents double-spawn from fast-path + reactive)
    const current = this.blackboard.getTask(task.id);
    if (current && current.status !== 'pending') {
      logger.debug({ taskId: task.id, status: current.status }, 'Task already picked up, skipping');
      return null;
    }

    if (!this.registry.canSpawn()) {
      logger.warn('Max agents reached, cannot spawn');
      return null;
    }

    const skill = this.findSkillForRole(task.role);
    const executor = this.resolveExecutor(skill, task);
    if (!executor) {
      logger.error('No executor available');
      return null;
    }

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;

    // Create per-agent data directory with MEMORY.md
    const agentDir = path.join(config.dataDir, 'agents', id);
    fs.mkdirSync(agentDir, { recursive: true });
    const memoryPath = path.join(agentDir, 'MEMORY.md');
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, `# Agent ${id} Memory\n\nCreated: ${new Date().toISOString()}\nRole: ${task.role}\nTask: ${task.prompt.slice(0, 100)}\n`);
    }

    // Register agent
    const now = new Date().toISOString();
    const agent: AgentInfo = {
      id,
      role: task.role,
      status: 'working',
      currentTaskId: task.id,
      pid: null,
      startedAt: now,
      lastActivityAt: now,
      executor: executor.name,
      outputBytes: 0,
    };
    this.registry.register(agent);

    // Update task status
    this.blackboard.updateTask(task.id, { status: 'running', agentId: id });
    this.addFeed('agent_spawned', id, `Agent ${id} spawned for: ${task.prompt.slice(0, 100)}`, task.id);

    // Setup abort + timeout
    const abort = new AbortController();
    let lastActivity = Date.now();
    const timeout = setInterval(() => {
      if (Date.now() - lastActivity > config.agentTimeoutMs) {
        logger.warn({ id }, 'Agent timed out');
        abort.abort();
        clearInterval(timeout);
      }
    }, 10000);

    // Run executor — tracked promise (not fire-and-forget)
    const runningAgent: RunningAgent = { abort, timeout, promise: null!, startedAt: Date.now(), outputBytes: 0 };
    const promise = this.runExecutor(id, task, skill, executor, abort, timeout, runningAgent, () => { lastActivity = Date.now(); });
    runningAgent.promise = promise;
    this.running.set(id, runningAgent);

    promise.catch((err) => {
      logger.error({ id, err }, 'Unhandled agent error');
    });

    return id;
  }

  private async runExecutor(
    id: string,
    task: Task,
    skill: Skill | null,
    executor: AgentExecutor,
    abort: AbortController,
    timeout: NodeJS.Timeout,
    runningAgent: RunningAgent,
    onActivity: () => void,
  ): Promise<void> {
    try {
      const result = await executor.execute({
        task,
        skill,
        signal: abort.signal,
        onProgress: (chunk) => {
          onActivity();
          runningAgent.outputBytes += chunk.length;
          this.registry.update(id, { outputBytes: runningAgent.outputBytes });
        },
        requestApproval: async (description) => {
          logger.info({ agentId: id, description: description.slice(0, 200) }, 'Auto-approved tool request');
          return true;
        },
      });

      clearInterval(timeout);
      this.running.delete(id);

      const meta = result.meta || {};
      const taskUpdate: Partial<Task> = {
        status: 'completed',
        result: result.content || null,
      };
      if (meta.sessionId) {
        taskUpdate.sessionId = meta.sessionId as string;
      }
      this.blackboard.updateTask(task.id, taskUpdate);
      this.addFeed('agent_result', id,
        `Result (${meta.inputTokens ?? '?'}in/${meta.outputTokens ?? '?'}out): ${result.content.slice(0, 500)}`,
        task.id);
      this.registry.update(id, { status: 'stopped', currentTaskId: null });
      this.registry.remove(id);

      logger.info({ id, executor: executor.name, ...meta }, 'Agent completed');

      // Slot freed — pick up next pending task
      this.drainPending();
    } catch (err) {
      clearInterval(timeout);
      this.running.delete(id);

      const isAborted = err instanceof Error && err.name === 'AbortError';
      if (isAborted) {
        this.blackboard.updateTask(task.id, { status: 'cancelled' });
        this.addFeed('agent_killed', id, `Agent ${id} cancelled`, task.id);
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.blackboard.updateTask(task.id, { status: 'failed', error: errMsg });
        this.addFeed('agent_error', id, `Error: ${errMsg}`, task.id);
        logger.error({ id, err }, 'Agent failed');
      }

      this.registry.update(id, { status: 'stopped', currentTaskId: null });
      this.registry.remove(id);

      // Slot freed — pick up next pending task
      this.drainPending();
    }
  }

  /**
   * Get a natural language progress description for a running agent.
   */
  getProgress(id: string): string | null {
    const r = this.running.get(id);
    if (!r) return null;
    const elapsed = Math.round((Date.now() - r.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const output = r.outputBytes > 0 ? `, ${r.outputBytes} bytes produced so far` : ', waiting for output';
    return `Running for ${timeStr}${output}`;
  }

  /**
   * Create an approval request on behalf of an executor.
   * Returns a promise that resolves when the user approves/rejects.
   */
  private createApprovalRequest(agentId: string, taskId: string, description: string): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    this.blackboard.requestApproval({
      id: approvalId,
      taskId,
      description: `[${agentId}] ${description}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    return new Promise<boolean>((resolve) => {
      const onResolved = (approval: Approval) => {
        if (approval.id === approvalId) {
          this.blackboard.removeListener('approval:resolved', onResolved);
          resolve(approval.status === 'approved');
        }
      };
      this.blackboard.on('approval:resolved', onResolved);
    });
  }

  killAgent(id: string): void {
    const running = this.running.get(id);
    if (!running) return;

    logger.info({ id }, 'Killing agent');
    running.abort.abort();
    clearInterval(running.timeout);
    this.running.delete(id);

    const agent = this.registry.get(id);
    if (agent?.currentTaskId) {
      this.blackboard.updateTask(agent.currentTaskId, { status: 'cancelled' });
    }
    this.addFeed('agent_killed', id, `Agent ${id} killed`, agent?.currentTaskId ?? null);
    this.registry.update(id, { status: 'stopping' });
  }

  killAll(): void {
    for (const id of this.running.keys()) {
      this.killAgent(id);
    }
  }

  /**
   * Resolve which executor to use.
   * Priority: task.executor > skill.executor > 'llm' default.
   */
  private resolveExecutor(skill: Skill | null, task?: Task): AgentExecutor | undefined {
    const name = task?.executor || skill?.executor || 'llm';
    return this.executors.get(name) || this.executors.values().next().value;
  }

  private findSkillForRole(role: AgentRole): Skill | null {
    return this.skills.find((s) => s.name.includes(role)) || this.skills[0] || null;
  }

  private addFeed(type: FeedEntry['type'], source: string, content: string, taskId: string | null): void {
    this.blackboard.addFeed({
      id: crypto.randomUUID(),
      type,
      source,
      content,
      taskId,
      timestamp: new Date().toISOString(),
    });
  }
}
