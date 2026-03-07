import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Task, AgentInfo, Skill, FeedEntry, Approval, AuditorMode } from '../types.js';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { loadSkills } from '../skills/loader.js';
import { prepareTaskContext } from '../skills/context.js';
import { decide, assessRisk } from '../blackboard/permissions.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface RunningAgent {
  abort: AbortController;
  timeout: NodeJS.Timeout;
  promise: Promise<void>;
  startedAt: number;
  outputBytes: number;
  lastProgressText: string;
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
   * Reload skills from disk. Called before spawning so newly installed
   * skills are available without restart.
   */
  reloadSkills(): void {
    this.skills = loadSkills(config.skillsDir, config.extraSkillsDirs);
  }

  /**
   * Get currently loaded skills (for classifier context).
   */
  getSkills(): Skill[] {
    return this.skills;
  }

  /**
   * Get installed MCP servers from .mcp.json (for classifier context).
   */
  getInstalledMCPs(): string[] {
    try {
      const mcpPath = path.join(process.cwd(), '.mcp.json');
      if (!fs.existsSync(mcpPath)) return [];
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      return Object.keys(mcpConfig.mcpServers || {});
    } catch {
      return [];
    }
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

    // Hot-reload skills so newly installed ones are available
    this.reloadSkills();

    const skill = this.findSkillForTask(task);
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

    // Setup abort + inactivity check via Blackboard
    const abort = new AbortController();
    const timeout = setInterval(() => {
      const agentRecord = this.blackboard.getAgent(id);
      if (!agentRecord) { clearInterval(timeout); return; }
      const lastAt = new Date(agentRecord.lastActivityAt).getTime();
      if (Date.now() - lastAt > config.agentTimeoutMs) {
        logger.warn({ id, lastActivityAt: agentRecord.lastActivityAt }, 'Agent timed out (no Blackboard activity)');
        abort.abort();
        clearInterval(timeout);
      }
    }, 10000);

    // Run executor — tracked promise (not fire-and-forget)
    const runningAgent: RunningAgent = { abort, timeout, promise: null!, startedAt: Date.now(), outputBytes: 0, lastProgressText: '' };
    const promise = this.runExecutor(id, task, skill, executor, abort, timeout, runningAgent);
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
  ): Promise<void> {
    try {
      const effectiveModel = task.model || skill?.model || undefined;
      const prepared = prepareTaskContext(task, skill);

      // Throttle Blackboard writes: update lastActivityAt every 5s, progress feed every 30s
      let lastActivityWrite = 0;
      let lastFeedWrite = 0;
      let progressBuffer = '';

      const result = await executor.execute({
        task,
        prepared,
        signal: abort.signal,
        model: effectiveModel,
        onProgress: (chunk) => {
          const now = Date.now();

          if (chunk.length > 0) {
            runningAgent.outputBytes += chunk.length;
            progressBuffer += chunk;
          }

          // Update agent lastActivityAt in Blackboard (throttled: every 5s)
          if (now - lastActivityWrite > 5_000) {
            lastActivityWrite = now;
            const nowIso = new Date().toISOString();
            this.blackboard.updateAgent(id, { lastActivityAt: nowIso, outputBytes: runningAgent.outputBytes });
          }

          // Write progress feed entry to Blackboard (throttled: every 30s, only if meaningful text)
          if (progressBuffer.length > 0 && now - lastFeedWrite > 30_000) {
            lastFeedWrite = now;
            // Keep last ~200 chars as a summary
            const summary = progressBuffer.length > 200
              ? '...' + progressBuffer.slice(-200)
              : progressBuffer;
            runningAgent.lastProgressText = summary;
            progressBuffer = '';
            this.addFeed('agent_progress', id, summary, task.id);
          }
        },
        requestApproval: async (description) => {
          const mode = this.resolveAuditorMode(skill);
          const risk = assessRisk(description);
          const decision = decide(description, mode);
          if (decision === 'allow') {
            this.addFeed('system', 'auditor',
              `[${mode}/${risk}] Approved: ${description.slice(0, 200)}`, task.id);
            logger.info({ agentId: id, mode, risk, description: description.slice(0, 200) }, 'Permission auto-approved');
            return true;
          }
          // Escalate to user — park agent and wait for response
          this.addFeed('system', 'auditor',
            `[${mode}/${risk}] Escalating to user: ${description.slice(0, 200)}`, task.id);
          logger.info({ agentId: id, mode, risk, description: description.slice(0, 200) }, 'Permission escalated to user');
          return this.createApprovalRequest(id, task.id, description);
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
   * Reads real progress from Blackboard feeds + agent record.
   */
  getProgress(id: string): string | null {
    const r = this.running.get(id);
    if (!r) return null;

    const elapsed = Math.round((Date.now() - r.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Get latest progress from Blackboard feed or in-memory buffer
    const agent = this.blackboard.getAgent(id);
    const taskId = agent?.currentTaskId;
    let progressSummary = '';

    if (taskId) {
      const recentFeeds = this.blackboard.getTaskFeeds(taskId, 'agent_progress', 1);
      if (recentFeeds.length > 0) {
        // Truncate for display
        const text = recentFeeds[0].content.replace(/\n/g, ' ').trim();
        progressSummary = text.length > 120 ? text.slice(-120) : text;
      }
    }

    // Fallback to in-memory last progress text if no feed written yet
    if (!progressSummary && r.lastProgressText) {
      const text = r.lastProgressText.replace(/\n/g, ' ').trim();
      progressSummary = text.length > 120 ? text.slice(-120) : text;
    }

    const output = r.outputBytes > 0 ? `, ${r.outputBytes}B output` : '';
    const progress = progressSummary ? ` — ${progressSummary}` : '';
    return `${timeStr}${output}${progress}`;
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
    const preferred = this.executors.get(name);
    if (preferred) return preferred;

    const fallback = this.executors.get('llm') || this.executors.values().next().value;
    logger.warn({ requested: name, fallback: fallback?.name }, 'Requested executor unavailable, using fallback');
    return fallback;
  }

  /**
   * Find the best skill for a task.
   * Matches by: task prompt keywords vs skill name/description.
   * Falls back to role-based match, then first skill.
   */
  private findSkillForTask(task: Task): Skill | null {
    const eligibleSkills = this.skills.filter((skill) => skill.eligibility.eligible);
    if (eligibleSkills.length === 0) return null;

    const prompt = task.prompt.toLowerCase();

    // Score each skill by keyword overlap with the task prompt
    let bestSkill: Skill | null = null;
    let bestScore = 0;

    for (const skill of eligibleSkills) {
      const keywords = `${skill.name} ${skill.description}`.toLowerCase().split(/\W+/);
      let score = 0;
      for (const kw of keywords) {
        if (kw.length > 2 && prompt.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    if (bestSkill && bestScore > 0) return bestSkill;

    // Fallback: match by role name
    return eligibleSkills.find((s) => s.name.includes(task.role)) || eligibleSkills[0] || null;
  }

  /**
   * Resolve the auditor mode for a task.
   * Priority: per-skill override > global config.
   */
  private resolveAuditorMode(skill: Skill | null): AuditorMode {
    if (skill && config.auditorOverrides[skill.name]) {
      return config.auditorOverrides[skill.name];
    }
    return config.auditorMode;
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
