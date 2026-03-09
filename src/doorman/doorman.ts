import crypto from 'crypto';
import { spawn } from 'child_process';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRunner } from '../agents/runner.js';
import { AgentRegistry } from '../agents/registry.js';
import { CodexRuntime } from '../agents/codex-runtime.js';
import { Channel, UserMessage, Task, Approval } from '../types.js';
import { config, channelDbPath } from '../config.js';
import { logger } from '../logger.js';
import { buildSkillInstallTaskPrompt, parseSkillInstallIntent } from '../skills/commands.js';

/**
 * Doorman action — returned by the Doorman CLI triage call.
 */
interface DoormanAction {
  response: string;
  tasks?: { prompt: string; executor?: string; model?: string }[];
  kill?: boolean | string;
  approve?: { id: string; accept: boolean };
}

// --- Fast path patterns (no LLM needed) ---
const STATUS_PATTERNS = /^(.*\bstatus\b.*|what('s| is) (happening|going on)|show state|overview)\s*[.!?]*$/i;
const KILL_ALL_PATTERNS = /^(stop|cancel|kill|abort|quit)\s*(all|everything|agents?)?\s*[.!?]*$/i;
const APPROVAL_POSITIVE = /\b(approve|yes|accept|confirm|ok|okay|go ahead|do it)\b/i;
const APPROVAL_NEGATIVE = /\b(reject|no|deny|decline|don't|cancel)\b/i;

// --- Fast-path task detection: skip LLM triage for obvious work requests ---
// These patterns indicate the user clearly wants work done, not a conversation.
// Matches imperative verbs at the start, or explicit work phrases anywhere.
const FAST_TASK_PATTERNS = [
  /^(write|create|build|generate|implement|code|develop|make)\s+/i,       // "write a function...", "create a script..."
  /^(research|investigate|analyze|compare|find out|look up|look into)\s+/i, // "research the top...", "analyze this..."
  /^(fix|debug|solve|resolve|patch|repair)\s+/i,                          // "fix this bug...", "debug the error..."
  /^(refactor|optimize|improve|clean up|rewrite)\s+/i,                    // "refactor the module..."
  /^(test|run|execute|deploy|install|setup|configure)\s+/i,               // "test the API...", "run the migration..."
  /^(read|open|check|browse|fetch|scrape|download)\s+(the |my |this |a |https?:)/i,  // "read my package.json", "browse https://..."
  /^(summarize|translate|convert|format|parse|transform)\s+/i,            // "summarize this error...", "convert CSV to JSON..."
  /^(draft|compose|prepare|outline)\s+/i,                                 // "draft a Slack message...", "compose an email..."
  /^(list|show me|give me|get|pull)\s+(the |all |my |recent |\d)/i,       // "list all files...", "show me the logs..."
  /^(go to|navigate to|visit)\s+https?:/i,                                // "go to https://..."
];

/**
 * The Doorman is a persistent CLI session.
 *
 * User messages become prompts to a local CLI brain (`claude` or `codex`)
 * with session continuity via resume/thread IDs.
 */
export class Doorman {
  private channels: Channel[] = [];
  private sessionIds: Map<string, string> = new Map();
  private doormanExecutor: string;
  private cliPath: string;
  private toolExecutor: string;
  private codexRuntime: CodexRuntime | null = null;

  constructor(
    private blackboard: Blackboard,
    private runner: AgentRunner,
    private registry: AgentRegistry,
  ) {
    this.doormanExecutor = this.resolveDoormanExecutor();
    this.cliPath = this.resolveDoormanCliPath(this.doormanExecutor);
    this.toolExecutor = config.toolExecutor
      || (config.claudeCliPath ? 'claude-code' : config.codexCliPath ? 'codex-cli' : 'claude-code');
    if (this.doormanExecutor === 'codex-cli') {
      this.codexRuntime = new CodexRuntime({
        cliPath: this.cliPath,
        mode: config.codexExecutionMode,
        hostBridgeUrl: config.codexHostBridgeUrl,
        hostBridgeToken: config.codexHostBridgeToken,
        hostBridgeTimeoutMs: config.codexHostBridgeTimeoutMs,
      });
      if (config.codexExecutionMode === 'host-bridge') {
        logger.warn('Doorman codex-cli is using host-bridge mode; this path depends on the external host bridge for native-execution safety controls');
      }
    }
    logger.info({ executor: this.doormanExecutor, cliPath: this.cliPath, toolExecutor: this.toolExecutor }, 'Doorman configured');

    this.blackboard.on('approval:requested', (approval) => {
      const task = this.blackboard.getTask(approval.taskId);
      const channelId = this.resolveRouteableSource(task?.source);
      if (channelId) {
        this.sendToChannels(`Approval needed: ${approval.description}\nReply "approve" or "reject".`, channelId);
      }
    });

    this.blackboard.on('task:updated', (task: Task) => {
      const channelId = this.resolveRouteableSource(task.source);
      if (!channelId) return;
      if (task.status === 'completed' && task.result) {
        if (task.executor === 'skill-installer') {
          this.sendToChannels(task.result, channelId);
          return;
        }
        const label = task.prompt.length > 60 ? task.prompt.slice(0, 57) + '...' : task.prompt;
        const executor = task.executor || 'agent';
        this.sendToChannels(`[${executor}] ${label}\n\n${task.result}`, channelId);
      } else if (task.status === 'failed') {
        const label = task.prompt.length > 60 ? task.prompt.slice(0, 57) + '...' : task.prompt;
        this.sendToChannels(`[failed] ${label}\n\n${task.error || 'Unknown error'}. Let me know if you'd like me to retry.`, channelId);
      }
    });
  }

  addChannel(channel: Channel): void {
    this.channels.push(channel);
  }

  async handleMessage(msg: UserMessage): Promise<void> {
    this.blackboard.addFeed({
      id: crypto.randomUUID(),
      type: 'user_message',
      source: msg.channelId,
      content: msg.content,
      taskId: null,
      timestamp: msg.timestamp,
    });

    const trimmed = msg.content.trim();

    // --- Fast path: handle locally without CLI call ---

    // Approval responses
    const pendingApprovals = this.blackboard.getPendingApprovals().filter((approval) => {
      const task = this.blackboard.getTask(approval.taskId);
      return this.resolveRouteableSource(task?.source) === msg.channelId;
    });
    if (pendingApprovals.length > 0 && trimmed.split(/\s+/).length <= 5) {
      if (APPROVAL_POSITIVE.test(trimmed)) {
        this.blackboard.resolveApproval(pendingApprovals[0].id, 'approved');
        await this.respond('Approved.', msg.channelId);
        return;
      }
      if (APPROVAL_NEGATIVE.test(trimmed)) {
        this.blackboard.resolveApproval(pendingApprovals[0].id, 'rejected');
        await this.respond('Rejected.', msg.channelId);
        return;
      }
    }

    // Kill
    if (KILL_ALL_PATTERNS.test(trimmed)) {
      const running = this.registry.getRunning();
      if (running.length === 0) {
        await this.respond('Nothing running right now.', msg.channelId);
      } else {
        this.runner.killAll();
        await this.respond(`Stopped all ${running.length} running task${running.length > 1 ? 's' : ''}.`, msg.channelId);
      }
      return;
    }

    // Status
    if (STATUS_PATTERNS.test(trimmed)) {
      await this.respondStatus(msg.channelId);
      return;
    }

    // Skill install intent: route through the blackboard task pipeline, not direct mutation
    const installIntent = parseSkillInstallIntent(trimmed);
    if (installIntent) {
      await this.createTask(buildSkillInstallTaskPrompt(installIntent.reference), 'skill-installer', undefined, msg.channelId);
      await this.respond(`Installing skill "${installIntent.reference}".`, msg.channelId);
      return;
    }

    // --- Fast-path task routing: skip LLM triage for obvious work requests ---
    if (FAST_TASK_PATTERNS.some(p => p.test(trimmed))) {
      logger.info({ msg: trimmed.slice(0, 80) }, 'Fast-path: routing as task (skipping triage)');
      const needsTools = this.messageNeedsTools(trimmed);
      await this.createTask(trimmed, needsTools ? this.toolExecutor : undefined, undefined, msg.channelId);
      await this.respond("On it.", msg.channelId);
      return;
    }

    // --- Doorman CLI call: triage + respond ---
    await this.showTyping(msg.channelId);
    const action = await this.askDoormanCli(trimmed, msg.channelId);

    // Execute actions
    if (action.tasks && action.tasks.length > 0) {
      for (const t of action.tasks) {
        await this.createTask(t.prompt, t.executor, t.model, msg.channelId);
      }
    }

    if (action.kill) {
      if (typeof action.kill === 'string') {
        this.runner.killAgent(action.kill);
      } else {
        this.runner.killAll();
      }
    }

    if (action.approve) {
      this.blackboard.resolveApproval(
        action.approve.id,
        action.approve.accept ? 'approved' : 'rejected',
      );
    }

    await this.respond(action.response, msg.channelId);
  }

  /**
   * Ask the configured Doorman CLI with session continuity.
   */
  private async askDoormanCli(content: string, channelId: string): Promise<DoormanAction> {
    const state = this.blackboard.getState();
    const scopedTasks = state.tasks.filter((task) => this.resolveRouteableSource(task.source) === channelId);
    const running = state.agents.filter((a) => {
      if (a.status !== 'working') return false;
      const task = state.tasks.find((t) => t.id === a.currentTaskId);
      return this.resolveRouteableSource(task?.source) === channelId;
    });
    const skills = this.runner.getSkills();
    const mcps = this.runner.getInstalledMCPs();

    // Build live context for routing decisions
    const runningCtx = running.length > 0
      ? `\nRunning agents:\n${running.map(a => {
          const task = state.tasks.find(t => t.id === a.currentTaskId);
          const progress = this.runner.getProgress(a.id);
          return `- ${a.id}: "${task?.prompt.slice(0, 80) || '?'}" ${progress || ''}`;
        }).join('\n')}`
      : '';

    const skillCtx = skills.length > 0
      ? `\nInstalled skills: ${skills.map(s => s.name).join(', ')}`
      : '';

    const mcpCtx = mcps.length > 0
      ? `\nInstalled MCP tools: ${mcps.join(', ')}`
      : '';

    // Include recent task results so Doorman remembers what agents discovered
    const recentResults = this.buildRecentResults(state, channelId);

    // The prompt: user message + routing context + agent results
    const prompt = `You are Meridian — a personal AI agent system. You are always on, always responsive. You are the user's primary interface to the system.

Respond with a JSON object (no markdown fences).
Schema: {"response": "your message to the user", "tasks": [{"prompt": "task description", "executor": "${this.toolExecutor} or omit", "model": "optional model override"}]}

What you answer directly (no task needed):
- About yourself: what model you are, what you can do, your capabilities, your name
- Conversation: greetings, follow-ups, clarifications, acknowledgements
- System state: what agents are running, queue status, recent results (you have this in your live context below)
- Knowledge questions: "what does X mean?", "explain Y", "how does Z work?"

What you delegate to an agent (create a task):
- Anything requiring real-world action: checking services, reading files, running commands, browsing, using MCP tools
- Work requests: writing code, research, analysis, creating documents
- Verification that requires actually checking: "is the server up?", "what's in the database?"

The test: if answering requires tools, shell access, file I/O, or external verification — delegate. If you can answer from self-knowledge and the live context below — answer directly.

Examples (follow these patterns):
- "check if the server is up" → delegate (needs real verification)
- "what does 'deploy' mean?" → answer directly (knowledge question about a word)
- "I ran the test yesterday" → answer directly (conversation)
- "read my package.json" → delegate (needs file access)
- "write a poem about rain" → delegate (creative work)
- "how are you?" → answer directly (greeting)
- "what's in the logs?" → delegate (needs shell access)
- "can you explain what a blackboard is?" → answer directly (knowledge question)

When delegating, set "response" to a brief natural ack and create tasks. Use executor "${this.toolExecutor}" for tasks needing tools/files/shell/MCP. Omit executor for pure text generation. Optionally set "model" to override the default model for cost control.

Live context: ${running.length} running, ${scopedTasks.filter(t => t.status === 'pending').length} queued, ${scopedTasks.filter(t => t.status === 'completed').length} completed.${runningCtx}${skillCtx}${mcpCtx}${recentResults}

    User message: ${content}`;

    try {
      const result = await this.spawnDoorman(prompt, channelId);
      return this.parseAction(result.content, content);
    } catch (err) {
      logger.error({ err, executor: this.doormanExecutor }, 'Doorman CLI call failed');
      return { response: 'Sorry, something went wrong. Try again or just describe what you need.' };
    }
  }

  /**
   * Build a summary of recent agent results so the Doorman has context about
   * what its agents discovered. Without this, the --resume session only
   * contains triage calls, not the actual work results.
   */
  private buildRecentResults(state: import('../types.js').BlackboardState, channelId: string): string {
    const recentCompleted = state.tasks
      .filter((t) => t.status === 'completed' && t.result && this.resolveRouteableSource(t.source) === channelId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);  // last 5 completed tasks

    if (recentCompleted.length === 0) return '';

    const summaries = recentCompleted.map(t => {
      const truncated = t.result!.length > 500
        ? t.result!.slice(0, 500) + '...'
        : t.result!;
      return `- Task: "${t.prompt.slice(0, 80)}"\n  Result: ${truncated}`;
    });

    return `\n\nRecent agent results (for context — DO NOT repeat these to the user unless asked):\n${summaries.join('\n')}`;
  }

  /**
   * Spawn the configured Doorman CLI with optional session continuity.
   */
  private spawnDoorman(prompt: string, channelId: string): Promise<{ content: string; sessionId?: string }> {
    if (this.doormanExecutor === 'codex-cli') {
      return this.spawnCodex(prompt, channelId);
    }
    return this.spawnClaude(prompt, channelId);
  }

  private spawnClaude(prompt: string, channelId: string): Promise<{ content: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'json',
        '--dangerously-skip-permissions',
      ];

      const sessionId = this.sessionIds.get(channelId) || null;

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      args.push(prompt);

      logger.debug({ resume: sessionId || 'new', promptLen: prompt.length, channelId }, 'Doorman CLI call');

      const child = spawn(this.cliPath, args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: undefined },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn Doorman CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `claude CLI exited with code ${code}`));
          return;
        }

        // Parse JSON output for session_id and result
        try {
          const json = JSON.parse(stdout.trim());
          const content = typeof json.result === 'string' ? json.result
            : typeof json.content === 'string' ? json.content
            : stdout.trim();
          const sessionId = json.session_id ?? json.sessionId;

          // Store session for next call (conversation continuity)
          if (sessionId) {
            this.sessionIds.set(channelId, sessionId);
            logger.debug({ sessionId, channelId }, 'Doorman session updated');
          }

          resolve({ content, sessionId });
        } catch {
          // Raw text output
          resolve({ content: stdout.trim() });
        }
      });
    });
  }

  private spawnCodex(prompt: string, channelId: string): Promise<{ content: string; sessionId?: string }> {
    if (!this.codexRuntime) {
      return Promise.reject(new Error('Codex runtime is not initialized'));
    }

    const sessionId = this.sessionIds.get(channelId) || null;

    logger.debug({
      resume: sessionId || 'new',
      promptLen: prompt.length,
      executor: 'codex-cli',
      launchMode: this.codexRuntime.mode,
      channelId,
    }, 'Doorman CLI call');

    return this.codexRuntime.invoke({
      prompt,
      cwd: process.cwd(),
      purpose: 'doorman',
      sessionId: sessionId || undefined,
    }).then((result) => {
      if (result.sessionId) {
        this.sessionIds.set(channelId, result.sessionId);
        logger.debug({ sessionId: result.sessionId, channelId }, 'Doorman session updated');
      }

      return {
        content: result.content,
        sessionId: result.sessionId,
      };
    });
  }

  private resolveDoormanExecutor(): string {
    if (config.doormanExecutor) return config.doormanExecutor;
    if (config.codexCliPath) return 'codex-cli';
    return 'claude-code';
  }

  private resolveDoormanCliPath(executor: string): string {
    if (executor === 'codex-cli') {
      return config.codexCliPath || 'codex';
    }
    return config.claudeCliPath || 'claude';
  }

  private parseAction(raw: string, originalContent: string): DoormanAction {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
    }

    // Messages that clearly need real-world action (tools, shell, files, verification)
    const NEEDS_ACTION = /\b(check|verify|is .+ (working|running|up|down|alive)|look at|read file|run |open |browse|install|deploy|fix|debug|test |build |create file|write file|delete|restart|start |stop service|process|logs?|database|query)\b/i;

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.response === 'string') {
        const action: DoormanAction = {
          response: parsed.response,
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(
            (t: any) => t && typeof t.prompt === 'string'
          ) : undefined,
          kill: parsed.kill,
          approve: parsed.approve,
        };

        // Structural guard: if Claude answered without creating tasks but
        // the message clearly needs real-world action, force-delegate.
        // Trust the LLM's routing for ambiguous cases — only override
        // when the message obviously requires tools/verification.
        if (this.messageNeedsAction(originalContent, NEEDS_ACTION) && (!action.tasks || action.tasks.length === 0) && !action.kill && !action.approve) {
          logger.info({ originalContent: originalContent.slice(0, 100) }, 'Doorman answered directly but message needs action — forcing task');
          action.response = "Let me look into that for you.";
          action.tasks = [{ prompt: originalContent, executor: this.toolExecutor }];
        }

        return action;
      }
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, 'Doorman returned non-JSON');
    }

    // Fallback for non-JSON: if it needs action, delegate; otherwise use as response
    if (this.messageNeedsAction(originalContent, NEEDS_ACTION)) {
      logger.info({ originalContent: originalContent.slice(0, 100) }, 'Fallback: routing as task');
      return {
        response: "Let me look into that for you.",
        tasks: [{ prompt: originalContent, executor: this.toolExecutor }],
      };
    }

    if (cleaned.length > 0) {
      return { response: cleaned };
    }

    return { response: "Hey! What can I help you with?" };
  }

  /**
   * Determine if a fast-path task needs tool access (file I/O, shell, browser)
   * vs pure text generation (writing, creative work, knowledge).
   */
  private messageNeedsTools(content: string): boolean {
    const toolPatterns = /\b(read|open|check|browse|fetch|scrape|download|file|directory|folder|logs?|database|deploy|install|setup|configure|run |execute|test |debug|fix|server|endpoint|api |url|https?:|package\.json|\.ts|\.js|\.py|\.md)\b/i;
    return toolPatterns.test(content);
  }

  private messageNeedsAction(content: string, needsActionPattern: RegExp): boolean {
    const normalized = content.trim().toLowerCase();
    const directAnswerPatterns = [
      /^what does .+ mean\??$/,
      /^(can you )?explain\b.+/,
      /^how does .+ work\??$/,
      /^how do you .+ internally\??$/,
      /^let me check with you\b.+/,
      /^i ran .+ yesterday\b.+/,
    ];

    if (directAnswerPatterns.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    return needsActionPattern.test(content);
  }

  /**
   * Find the sessionId from the most recent completed task (same executor).
   * This enables multi-turn: a follow-up task resumes the previous agent's
   * conversation, so the agent remembers what it did last time.
   */
  private findReusableSession(executor?: string, source?: string): string | undefined {
    if (!executor) return undefined;
    const recent = this.blackboard.getAllTasks()
      .filter((t) =>
        t.status === 'completed'
        && t.executor === executor
        && t.sessionId
        && (source ? this.resolveRouteableSource(t.source) === source : true)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return recent[0]?.sessionId ?? undefined;
  }

  private async createTask(prompt: string, executor?: string, model?: string, source?: string): Promise<void> {
    let enrichedPrompt = prompt;
    if (this.isToolExecutor(executor) && /\b(blackboard|database|sqlite|system.?check|self.?check|diagnos|state|db)\b/i.test(prompt)) {
      enrichedPrompt = `${prompt}\n\nContext: Meridian's blackboard is a SQLite database at ${channelDbPath}. Tables: tasks, agents, feeds, approvals, notes. Project root: ${process.cwd()}`;
    }

    // Reuse previous session for multi-turn continuity
    const sessionId = this.findReusableSession(executor, source);

    const task: Task = {
      id: crypto.randomUUID(),
      prompt: enrichedPrompt,
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      executor: executor || undefined,
      model: model || undefined,
      sessionId,
      source: source || 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.blackboard.createTask(task);
  }

  private isToolExecutor(executor?: string): boolean {
    return executor === 'claude-code' || executor === 'codex-cli';
  }

  private async respondStatus(channelId: string): Promise<void> {
    const state = this.blackboard.getState();
    const scopedTasks = state.tasks.filter((task) => this.resolveRouteableSource(task.source) === channelId);
    const running = state.agents.filter((a) => a.status === 'working' && scopedTasks.some((task) => task.id === a.currentTaskId));
    const pendingTasks = scopedTasks.filter(t => t.status === 'pending');
    const completedTasks = scopedTasks.filter(t => t.status === 'completed');
    const pendingApprovals = state.approvals.filter((approval) => {
      const task = this.blackboard.getTask(approval.taskId);
      return this.resolveRouteableSource(task?.source) === channelId;
    });

    let status = '';
    if (running.length === 0 && pendingTasks.length === 0) {
      status = 'All clear — no tasks running or queued. What would you like me to work on?';
    } else {
      if (running.length > 0) {
        status += `Working on ${running.length} task${running.length > 1 ? 's' : ''}:\n`;
        for (const agent of running) {
          const task = state.tasks.find(t => t.id === agent.currentTaskId);
          const progress = this.runner.getProgress(agent.id);
          status += `• ${task?.prompt.slice(0, 60) || 'unknown task'}`;
          if (progress) status += ` (${progress})`;
          status += '\n';
        }
      }
      if (pendingTasks.length > 0) {
        status += `\n${pendingTasks.length} task${pendingTasks.length > 1 ? 's' : ''} queued, waiting for a slot.\n`;
      }
      if (pendingApprovals.length > 0) {
        status += `\n${pendingApprovals.length} approval${pendingApprovals.length > 1 ? 's' : ''} waiting for your decision.\n`;
      }
      status += `\n${completedTasks.length} completed so far.`;
    }

    await this.respond(status, channelId);
  }

  private async respond(text: string, channelId?: string): Promise<void> {
    this.blackboard.addFeed({
      id: crypto.randomUUID(),
      type: 'doorman_response',
      source: 'doorman',
      content: text,
      taskId: null,
      timestamp: new Date().toISOString(),
    });
    await this.sendToChannels(text, channelId);
  }

  private async showTyping(channelId?: string): Promise<void> {
    for (const channel of this.channels) {
      if (channel.isConnected() && channel.setTyping) {
        await channel.setTyping(true, channelId).catch(() => {});
      }
    }
  }

  private async sendToChannels(text: string, channelId?: string): Promise<void> {
    for (const channel of this.channels) {
      if (channel.isConnected()) {
        await channel.sendMessage(text, channelId);
      }
    }
  }

  private resolveRouteableSource(source?: string): string | undefined {
    if (!source) return undefined;
    if (/^(tg|feishu|cli|a2ui):/.test(source)) return source;
    return undefined;
  }
}
