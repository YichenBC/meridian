import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Task, AgentInfo, Skill, FeedEntry, Approval, AuditorMode, Session } from '../types.js';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { loadSkills } from '../skills/loader.js';
import { prepareTaskContext, prepareTaskContextWithCatalog, BlackboardContext } from '../skills/context.js';
import { decide, assessRisk } from '../blackboard/permissions.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// --- Domain classification (keyword-based, no LLM needed) ---

function extractTags(prompt: string): string[] {
  const tagWords = prompt.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  // Filter to meaningful words, deduplicate
  const stopWords = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'about', 'what', 'how', 'can', 'does', 'will', 'not', 'are', 'was', 'were', 'been']);
  return [...new Set(tagWords.filter(w => !stopWords.has(w)))].slice(0, 10);
}

function classifyDomain(prompt: string, skillName?: string): { domain: string; tags: string[] } {
  // Skill-based shortcuts
  if (skillName?.includes('knowledge') || skillName?.includes('ingest') || skillName?.includes('query'))
    return { domain: 'knowledge', tags: extractTags(prompt) };
  if (skillName?.includes('daily-brief') || skillName?.includes('blogwatcher'))
    return { domain: 'research', tags: extractTags(prompt) };
  if (skillName?.includes('meridian-system'))
    return { domain: 'system', tags: ['meridian', 'codebase'] };

  // Prompt-based fallback
  if (/vault|obsidian|ingest|save this|knowledge|总结|整理|笔记|链接|论文|知识|摘要|归纳|沉淀|收藏/i.test(prompt))
    return { domain: 'knowledge', tags: extractTags(prompt) };
  if (/fix|bug|code|refactor|test|build/i.test(prompt))
    return { domain: 'coding', tags: extractTags(prompt) };
  if (/research|paper|arxiv|analyze|调研|研究|分析/i.test(prompt))
    return { domain: 'research', tags: extractTags(prompt) };

  return { domain: 'general', tags: extractTags(prompt) };
}

function findBestSession(task: Task, sessions: Session[]): Session | null {
  const { domain, tags } = classifyDomain(task.prompt);
  let best: Session | null = null;
  let bestScore = 0;

  for (const session of sessions) {
    let score = 0;
    // Domain match: +10
    if (session.domain === domain) score += 10;
    // Tag overlap: +2 per matching tag
    const sessionTags = (session.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    for (const tag of tags) {
      if (sessionTags.includes(tag)) score += 2;
    }
    // Recency bonus: +5 if used in last hour, +3 if last day
    const age = Date.now() - new Date(session.lastUsedAt).getTime();
    if (age < 3600_000) score += 5;
    else if (age < 86400_000) score += 3;
    // Experience bonus: +1 per prior task (cap at 5)
    score += Math.min(session.taskCount, 5);

    if (score > bestScore) {
      bestScore = score;
      best = session;
    }
  }

  // Minimum threshold: don't reuse irrelevant sessions
  return bestScore >= 10 ? best : null;
}

interface RunningAgent {
  abort: AbortController;
  timeout: NodeJS.Timeout;
  promise: Promise<void>;
  startedAt: number;
  outputBytes: number;
  lastProgressText: string;
  lastOutputAt: number;       // last time output was received
  stallWarned: boolean;       // whether we've already warned about stalling
}

export class AgentRunner {
  private running: Map<string, RunningAgent> = new Map();
  private executors: Map<string, AgentExecutor> = new Map();

  constructor(
    private blackboard: Blackboard,
    private registry: AgentRegistry,
    private skills: Skill[],
  ) {
    // React to new tasks and completed tasks (completed tasks may unblock DAG dependents)
    this.blackboard.on('task:created', () => this.drainPending());
    this.blackboard.on('task:updated', (task: Task) => {
      if (task.status === 'completed') this.drainPending();
    });
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
   * Spawn agents for as many pending tasks as slots allow.
   * Respects DAG dependencies (blockedBy) and priority ordering.
   */
  drainPending(): void {
    const pending = this.blackboard.getAllTasks()
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        // Higher priority first, then FIFO by creation time
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pb - pa;
        return a.createdAt.localeCompare(b.createdAt);
      });

    for (const task of pending) {
      if (!this.registry.canSpawn()) break;

      // DAG gate: skip tasks whose blockers haven't completed yet
      if (task.blockedBy && task.blockedBy.length > 0) {
        if (!this.blackboard.areBlockersComplete(task.blockedBy)) {
          continue;
        }
      }

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
    // Atomic check-and-update: UPDATE ... WHERE status = 'pending' ensures no race
    const claimed = this.blackboard.claimTask(task.id);
    if (!claimed) {
      logger.debug({ taskId: task.id }, 'Task already picked up or missing, skipping');
      return null;
    }

    if (!this.registry.canSpawn()) {
      logger.warn('Max agents reached, cannot spawn');
      // Revert claim so the task can be picked up later
      this.blackboard.updateTask(task.id, { status: 'pending' });
      return null;
    }

    // Hot-reload skills so newly installed ones are available
    this.reloadSkills();

    const executor = this.resolveExecutor(null, task);
    if (!executor) {
      logger.error('No executor available');
      return null;
    }

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;

    // Session pool: find best matching session for this task if none pre-assigned
    if (!task.sessionId) {
      const allSessions = this.blackboard.getAllSessions();
      const bestSession = findBestSession(task, allSessions);
      if (bestSession) {
        task.sessionId = bestSession.sessionId;
        this.blackboard.updateTask(task.id, { sessionId: bestSession.sessionId });
        logger.info({ taskId: task.id, sessionPoolId: bestSession.id, domain: bestSession.domain },
          'Reusing session from pool');
      }
    }

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

    // Update task with agent assignment (status already set to 'running' by claimTask)
    this.blackboard.updateTask(task.id, { agentId: id });
    this.addFeed('agent_spawned', id, `Agent ${id} spawned for: ${task.prompt.slice(0, 100)}`, task.id);

    // Setup abort + graduated inactivity detection
    const abort = new AbortController();
    const spawnedAt = Date.now();
    const STALL_THRESHOLD_MS = Math.min(config.agentTimeoutMs / 3, 5 * 60 * 1000); // 1/3 of timeout or 5min, whichever is less

    const runningAgent: RunningAgent = {
      abort, timeout: null as any, promise: null!,
      startedAt: spawnedAt, outputBytes: 0, lastProgressText: '',
      lastOutputAt: spawnedAt, stallWarned: false,
    };

    const timeout = setInterval(() => {
      const agentRecord = this.blackboard.getAgent(id);
      if (!agentRecord) { clearInterval(timeout); return; }

      const elapsed = Date.now() - runningAgent.startedAt;
      const silentFor = Date.now() - runningAgent.lastOutputAt;

      // Hard timeout: no activity for the full timeout period → kill
      const lastAt = new Date(agentRecord.lastActivityAt).getTime();
      if (Date.now() - lastAt > config.agentTimeoutMs) {
        logger.warn({ id, elapsed: Math.round(elapsed / 1000), silentFor: Math.round(silentFor / 1000) },
          'Agent timed out — no activity');
        abort.abort();
        clearInterval(timeout);
        return;
      }

      // Stall warning: no output for a while but not yet timed out
      if (silentFor > STALL_THRESHOLD_MS && !runningAgent.stallWarned) {
        runningAgent.stallWarned = true;
        logger.warn({ id, silentForSec: Math.round(silentFor / 1000), outputBytes: runningAgent.outputBytes },
          'Agent may be stalled — no output received');
        this.addFeed('system', id,
          `Agent ${id} has been silent for ${Math.round(silentFor / 60000)}min (${runningAgent.outputBytes}B output so far)`,
          task.id);
      }
    }, 10000);
    runningAgent.timeout = timeout;
    const promise = this.runExecutor(id, task, null, executor, abort, timeout, runningAgent);
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
      const bbContext = this.buildBlackboardContext(task);

      // Use catalog-based skill selection (OpenClaw pattern): inject all eligible
      // skill descriptions into the prompt, let the agent pick and read the relevant SKILL.md.
      const eligibleSkills = this.skills.filter(s => s.eligibility.eligible);
      const prepared = prepareTaskContextWithCatalog(task, eligibleSkills, bbContext);

      // Throttle Blackboard writes: update lastActivityAt every 5s, progress feed every 30s
      let lastActivityWrite = 0;
      let lastFeedWrite = 0;
      let progressBuffer = '';

      const result = await executor.execute({
        task,
        prepared,
        signal: abort.signal,
        model: effectiveModel,
        onPid: (pid) => {
          // Store PID on agent record for process group kill support
          this.registry.update(id, { pid });
        },
        onProgress: (chunk) => {
          const now = Date.now();

          if (chunk.length > 0) {
            runningAgent.outputBytes += chunk.length;
            runningAgent.lastOutputAt = now;
            runningAgent.stallWarned = false; // reset stall warning on new output
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

      // Session pool: create or update session record
      const finalSessionId = (meta.sessionId as string) || task.sessionId;
      if (finalSessionId) {
        this.updateSessionPool(task, finalSessionId, result.content);
      }

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
      const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const timer = setTimeout(() => {
        this.blackboard.removeListener('approval:resolved', onResolved);
        logger.warn({ approvalId, agentId, taskId }, 'Approval timed out after 30 minutes');
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref();

      const onResolved = (approval: Approval) => {
        if (approval.id === approvalId) {
          clearTimeout(timer);
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

    // Kill process group if PID available (catches subprocesses)
    if (agent?.pid) {
      try { process.kill(-agent.pid, 'SIGTERM'); } catch {}
    }

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
    const name = task?.executor || skill?.executor || 'claude-code';
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

  /**
   * Build blackboard context for an agent: blocker results + relevant notes.
   * This is the "context windowing" — agents get a relevant slice, not everything.
   */
  private buildBlackboardContext(task: Task): BlackboardContext | undefined {
    const ctx: BlackboardContext = {};

    // Include results from completed blocker tasks (DAG predecessors)
    if (task.blockedBy && task.blockedBy.length > 0) {
      ctx.blockerResults = [];
      for (const blockerId of task.blockedBy) {
        const blocker = this.blackboard.getTask(blockerId);
        if (blocker?.status === 'completed' && blocker.result) {
          ctx.blockerResults.push({
            id: blocker.id,
            prompt: blocker.prompt,
            result: blocker.result,
          });
        }
      }
    }

    // Include notes tagged for this task
    if (task.id) {
      const taskNotes = this.blackboard.getTaskNotes(task.id);
      if (taskNotes.length > 0) {
        ctx.relevantNotes = taskNotes;
      }
    }

    // Include session memory if this task is reusing a pooled session
    if (task.sessionId) {
      const poolSession = this.blackboard.getSessionBySessionId(task.sessionId);
      if (poolSession) {
        const sessionDir = path.join(config.dataDir, 'sessions', task.sessionId.slice(0, 16));
        const memoryPath = path.join(sessionDir, 'MEMORY.md');
        try {
          if (fs.existsSync(memoryPath)) {
            ctx.sessionMemory = fs.readFileSync(memoryPath, 'utf-8');
          }
        } catch { /* file may not exist yet */ }
      }
    }

    // Inject domain-specific system prompt for knowledge tasks
    const { domain } = classifyDomain(task.prompt);
    if (domain === 'knowledge') {
      const knowledgePromptPath = path.join(config.skillsDir, 'knowledge-system', 'SYSTEM.md');
      try {
        if (fs.existsSync(knowledgePromptPath)) {
          ctx.domainSystemPrompt = fs.readFileSync(knowledgePromptPath, 'utf-8');
        }
      } catch { /* file may not exist */ }
    }

    return (ctx.blockerResults?.length || ctx.relevantNotes?.length || ctx.sessionMemory || ctx.domainSystemPrompt) ? ctx : undefined;
  }

  /**
   * Create or update a session record in the pool after task completion.
   * Also writes enriched MEMORY.md for the session.
   */
  private updateSessionPool(task: Task, sessionId: string, resultContent: string): void {
    const { domain, tags } = classifyDomain(task.prompt);
    const summary = `${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? '...' : ''}`;
    const now = new Date().toISOString();

    // Check if this session already exists in the pool
    const existing = this.blackboard.getSessionBySessionId(sessionId);

    if (existing) {
      // Update existing session
      const existingTags = (existing.tags || '').split(',').filter(Boolean);
      const mergedTags = [...new Set([...existingTags, ...tags])].join(',');
      this.blackboard.updateSession(existing.id, {
        taskCount: existing.taskCount + 1,
        summary: `${existing.summary} | ${summary}`,
        tags: mergedTags || null,
        lastUsedAt: now,
        domain: existing.domain === domain ? domain : existing.domain, // keep original domain if different
      });
      logger.info({ poolId: existing.id, taskCount: existing.taskCount + 1 }, 'Updated session in pool');
    } else {
      // Create new session record
      const poolId = `session-${crypto.randomUUID().slice(0, 8)}`;
      this.blackboard.createSession({
        id: poolId,
        sessionId,
        domain,
        summary,
        tags: tags.join(',') || null,
        taskCount: 1,
        lastUsedAt: now,
        createdAt: now,
      });
      logger.info({ poolId, domain, sessionId: sessionId.slice(0, 12) }, 'Created session in pool');
    }

    // Write enriched MEMORY.md
    this.enrichMemoryFile(sessionId, task, domain, tags, resultContent);
  }

  /**
   * Write/append to a session-specific MEMORY.md with task history.
   */
  private enrichMemoryFile(sessionId: string, task: Task, domain: string, tags: string[], resultContent: string): void {
    const sessionDir = path.join(config.dataDir, 'sessions', sessionId.slice(0, 16));
    fs.mkdirSync(sessionDir, { recursive: true });
    const memoryPath = path.join(sessionDir, 'MEMORY.md');

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const resultSummary = resultContent.length > 200
      ? resultContent.slice(0, 200) + '...'
      : resultContent;

    if (!fs.existsSync(memoryPath)) {
      // Create new MEMORY.md
      const content = `# Session ${sessionId.slice(0, 16)}\n\n## Domain: ${domain}\n## Tags: ${tags.join(', ')}\n\n## Task History\n### ${timestamp} — ${task.prompt.slice(0, 60)}\n${resultSummary}\n`;
      fs.writeFileSync(memoryPath, content);
    } else {
      // Append to existing
      const entry = `\n### ${timestamp} — ${task.prompt.slice(0, 60)}\n${resultSummary}\n`;
      fs.appendFileSync(memoryPath, entry);
    }
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
