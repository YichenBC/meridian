import crypto from 'crypto';
import { spawn } from 'child_process';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRunner } from '../agents/runner.js';
import { AgentRegistry } from '../agents/registry.js';
import { Channel, UserMessage, Task, Approval } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Doorman action — returned by the Claude Code CLI triage call.
 */
interface DoormanAction {
  response: string;
  tasks?: { prompt: string; executor?: string }[];
  kill?: boolean | string;
  approve?: { id: string; accept: boolean };
}

// --- Fast path patterns (no LLM needed) ---
const STATUS_PATTERNS = /^(.*\bstatus\b.*|what('s| is) (happening|going on)|show state|overview)\s*[.!?]*$/i;
const KILL_ALL_PATTERNS = /^(stop|cancel|kill|abort|quit)\s*(all|everything|agents?)?\s*[.!?]*$/i;
const APPROVAL_POSITIVE = /\b(approve|yes|accept|confirm|ok|okay|go ahead|do it)\b/i;
const APPROVAL_NEGATIVE = /\b(reject|no|deny|decline|don't|cancel)\b/i;

/**
 * The Doorman is a persistent Claude Code CLI session.
 *
 * User messages become prompts to `claude --print --resume <sessionId>`.
 * Claude Code naturally knows its own model, has tools, and maintains
 * conversation memory via session resumption. No separate LLM API needed.
 */
export class Doorman {
  private channels: Channel[] = [];
  private sessionId: string | null = null;
  private cliPath: string;

  constructor(
    private blackboard: Blackboard,
    private runner: AgentRunner,
    private registry: AgentRegistry,
  ) {
    this.cliPath = config.claudeCliPath || 'claude';

    this.blackboard.on('approval:requested', (approval) => {
      this.broadcast(`Approval needed: ${approval.description}\nReply "approve" or "reject".`);
    });

    this.blackboard.on('task:updated', (task: Task) => {
      if (task.status === 'completed' && task.result) {
        this.broadcast(task.result);
      } else if (task.status === 'failed') {
        this.broadcast(`Something went wrong: ${task.error || 'Unknown error'}. Let me know if you'd like me to retry.`);
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
    const pendingApprovals = this.blackboard.getPendingApprovals();
    if (pendingApprovals.length > 0 && trimmed.split(/\s+/).length <= 5) {
      if (APPROVAL_POSITIVE.test(trimmed)) {
        this.blackboard.resolveApproval(pendingApprovals[0].id, 'approved');
        await this.respond('Approved.');
        return;
      }
      if (APPROVAL_NEGATIVE.test(trimmed)) {
        this.blackboard.resolveApproval(pendingApprovals[0].id, 'rejected');
        await this.respond('Rejected.');
        return;
      }
    }

    // Kill
    if (KILL_ALL_PATTERNS.test(trimmed)) {
      const running = this.registry.getRunning();
      if (running.length === 0) {
        await this.respond('Nothing running right now.');
      } else {
        this.runner.killAll();
        await this.respond(`Stopped all ${running.length} running task${running.length > 1 ? 's' : ''}.`);
      }
      return;
    }

    // Status
    if (STATUS_PATTERNS.test(trimmed)) {
      await this.respondStatus();
      return;
    }

    // --- Claude Code CLI call: triage + respond ---
    await this.showTyping();
    const action = await this.askClaudeCode(trimmed);

    // Execute actions
    if (action.tasks && action.tasks.length > 0) {
      for (const t of action.tasks) {
        await this.createTask(t.prompt, t.executor);
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

    await this.respond(action.response);
  }

  /**
   * Ask Claude Code CLI via --print (with --resume for session continuity).
   * Claude Code IS the Doorman brain — it knows its own model, has memory,
   * and can answer any question about itself naturally.
   */
  private async askClaudeCode(content: string): Promise<DoormanAction> {
    const state = this.blackboard.getState();
    const running = state.agents.filter(a => a.status === 'working');
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
    const recentResults = this.buildRecentResults(state);

    // The prompt: user message + routing context + agent results
    // Claude Code already knows about itself — we only add Meridian-specific context
    const prompt = `You are Meridian — a personal AI agent system. You are always on, always responsive. You are the user's primary interface to the system.

Respond with a JSON object (no markdown fences).
Schema: {"response": "your message to the user", "tasks": [{"prompt": "task description", "executor": "claude-code or omit"}]}

What you answer directly (no task needed):
- About yourself: what model you are, what you can do, your capabilities, your name
- Conversation: greetings, follow-ups, clarifications, acknowledgements
- System state: what agents are running, queue status, recent results (you have this in your live context below)

What you delegate to an agent (create a task):
- Anything requiring real-world action: checking services, reading files, running commands, browsing, using MCP tools
- Work requests: writing code, research, analysis, creating documents
- Verification: "is X working?", "check Y", "what's in the database"

The test: if answering requires tools, shell access, file I/O, or external verification — delegate. If you can answer from self-knowledge and the live context below — answer directly.

When delegating, set "response" to a brief natural ack and create tasks. Use executor "claude-code" for tasks needing tools/files/shell/MCP. Omit executor for pure text generation.

Live context: ${running.length} running, ${state.tasks.filter(t => t.status === 'pending').length} queued, ${state.tasks.filter(t => t.status === 'completed').length} completed.${runningCtx}${skillCtx}${mcpCtx}${recentResults}

User message: ${content}`;

    try {
      const result = await this.spawnClaude(prompt);
      return this.parseAction(result.content, content);
    } catch (err) {
      logger.error({ err }, 'Doorman CLI call failed');
      return { response: 'Sorry, something went wrong. Try again or just describe what you need.' };
    }
  }

  /**
   * Build a summary of recent agent results so the Doorman has context about
   * what its agents discovered. Without this, the --resume session only
   * contains triage calls, not the actual work results.
   */
  private buildRecentResults(state: import('../types.js').BlackboardState): string {
    const recentCompleted = state.tasks
      .filter(t => t.status === 'completed' && t.result)
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
   * Spawn claude CLI with --print and optional --resume for session continuity.
   */
  private spawnClaude(prompt: string): Promise<{ content: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'json',
        '--dangerously-skip-permissions',
      ];

      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }

      args.push(prompt);

      logger.debug({ resume: this.sessionId || 'new', promptLen: prompt.length }, 'Doorman CLI call');

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
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
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
            this.sessionId = sessionId;
            logger.debug({ sessionId }, 'Doorman session updated');
          }

          resolve({ content, sessionId });
        } catch {
          // Raw text output
          resolve({ content: stdout.trim() });
        }
      });
    });
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
        if (NEEDS_ACTION.test(originalContent) && (!action.tasks || action.tasks.length === 0) && !action.kill && !action.approve) {
          logger.info({ originalContent: originalContent.slice(0, 100) }, 'Doorman answered directly but message needs action — forcing task');
          action.response = "Let me look into that for you.";
          action.tasks = [{ prompt: originalContent, executor: 'claude-code' }];
        }

        return action;
      }
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, 'Doorman returned non-JSON');
    }

    // Fallback for non-JSON: if it needs action, delegate; otherwise use as response
    if (NEEDS_ACTION.test(originalContent)) {
      logger.info({ originalContent: originalContent.slice(0, 100) }, 'Fallback: routing as task');
      return {
        response: "Let me look into that for you.",
        tasks: [{ prompt: originalContent, executor: 'claude-code' }],
      };
    }

    if (cleaned.length > 0) {
      return { response: cleaned };
    }

    return { response: "Hey! What can I help you with?" };
  }

  private async createTask(prompt: string, executor?: string): Promise<void> {
    let enrichedPrompt = prompt;
    if (executor === 'claude-code' && /\b(blackboard|database|sqlite|system.?check|self.?check|diagnos|state|db)\b/i.test(prompt)) {
      enrichedPrompt = `${prompt}\n\nContext: Meridian's blackboard is a SQLite database at ${config.dataDir}/meridian.db. Tables: tasks, agents, feeds, approvals, notes. Project root: ${process.cwd()}`;
    }

    const task: Task = {
      id: crypto.randomUUID(),
      prompt: enrichedPrompt,
      role: 'general',
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      executor: executor || undefined,
      source: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.blackboard.createTask(task);
  }

  private async respondStatus(): Promise<void> {
    const state = this.blackboard.getState();
    const running = state.agents.filter(a => a.status === 'working');
    const pendingTasks = state.tasks.filter(t => t.status === 'pending');
    const completedTasks = state.tasks.filter(t => t.status === 'completed');
    const pendingApprovals = state.approvals.filter(a => a.status === 'pending');

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

    await this.respond(status);
  }

  private async respond(text: string): Promise<void> {
    this.blackboard.addFeed({
      id: crypto.randomUUID(),
      type: 'doorman_response',
      source: 'doorman',
      content: text,
      taskId: null,
      timestamp: new Date().toISOString(),
    });
    await this.broadcast(text);
  }

  private async showTyping(): Promise<void> {
    for (const channel of this.channels) {
      if (channel.isConnected() && channel.setTyping) {
        await channel.setTyping(true).catch(() => {});
      }
    }
  }

  private async broadcast(text: string): Promise<void> {
    for (const channel of this.channels) {
      if (channel.isConnected()) {
        await channel.sendMessage(text);
      }
    }
  }
}
