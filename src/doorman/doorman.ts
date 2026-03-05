import crypto from 'crypto';
import { Blackboard } from '../blackboard/blackboard.js';
import { AgentRunner } from '../agents/runner.js';
import { AgentRegistry } from '../agents/registry.js';
import { ModelProvider } from '../providers/types.js';
import { classifyFastPath, classifyWithLLM } from './classifier.js';
import { Channel, UserMessage, Task, AgentRole, Intent } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class Doorman {
  private channels: Channel[] = [];

  constructor(
    private blackboard: Blackboard,
    private runner: AgentRunner,
    private registry: AgentRegistry,
    private provider: ModelProvider,
  ) {
    // Subscribe to blackboard events to relay results to user
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
    // Log user message as feed
    this.blackboard.addFeed({
      id: crypto.randomUUID(),
      type: 'user_message',
      source: msg.channelId,
      content: msg.content,
      taskId: null,
      timestamp: msg.timestamp,
    });

    const pendingApprovals = this.blackboard.getPendingApprovals();

    // Try fast path first (no LLM call needed)
    let intents = classifyFastPath(msg.content, pendingApprovals);

    if (!intents) {
      // Show typing while LLM classifier thinks
      await this.showTyping();
      const runningAgents = this.registry.getRunning();
      intents = await classifyWithLLM(
        msg.content,
        pendingApprovals,
        runningAgents,
        this.provider,
        config.model,
      );
    }

    logger.info(
      { intentCount: intents.length, types: intents.map(i => i.type), content: msg.content.slice(0, 80) },
      'Classified message',
    );

    // Process each intent
    for (const intent of intents) {
      await this.handleIntent(intent);
    }
  }

  private async handleIntent(intent: Intent): Promise<void> {
    switch (intent.type) {
      case 'chat':
        await this.respondChat(intent.content);
        break;

      case 'status':
        await this.respondStatus();
        break;

      case 'kill':
        await this.handleKill(intent.targetId);
        break;

      case 'approval':
        await this.handleApproval(intent.approve, intent.approvalId);
        break;

      case 'task':
        await this.delegateTask(intent.prompt, intent.role, intent.executor, intent.continueFrom);
        break;
    }
  }

  private buildSystemContext(): string {
    const state = this.blackboard.getState();
    const running = state.agents.filter(a => a.status === 'working');

    let ctx = '';
    if (running.length > 0) {
      ctx += '\n\nCurrently running agents:';
      for (const agent of running) {
        const task = state.tasks.find(t => t.id === agent.currentTaskId);
        const progress = this.runner.getProgress(agent.id);
        ctx += `\n- Agent ${agent.id} (${agent.role}): "${task?.prompt.slice(0, 100) || 'unknown'}"`;
        if (progress) {
          ctx += `\n  Progress: ${progress}`;
        }
      }
    }
    return ctx;
  }

  /**
   * Build conversation history from blackboard feeds.
   * Reconstructs recent user_message and doorman_response pairs as multi-turn messages.
   */
  private buildConversationHistory(limit = 20): { role: 'user' | 'assistant'; content: string }[] {
    const feeds = this.blackboard.getFeeds(100);
    const conversational = feeds.filter(
      f => (f.type === 'user_message' || f.type === 'doorman_response')
        && f.content.trim().length > 0
        && !f.content.startsWith('[Task completed]')
        && !f.content.startsWith('[Task failed]')
        && !f.content.startsWith('---'),
    );

    // Take the last N conversational feeds (excluding the current message which is already the latest)
    const recent = conversational.slice(-(limit + 1), -1);

    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const f of recent) {
      const role = f.type === 'user_message' ? 'user' as const : 'assistant' as const;
      // Merge consecutive same-role messages
      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n' + f.content;
      } else {
        messages.push({ role, content: f.content });
      }
    }

    // Ensure messages start with user (required by most APIs)
    while (messages.length > 0 && messages[0].role !== 'user') {
      messages.shift();
    }

    return messages;
  }

  private async respondChat(content: string): Promise<void> {
    try {
      await this.showTyping();
      const systemCtx = this.buildSystemContext();
      const history = this.buildConversationHistory();
      const messages = [...history, { role: 'user' as const, content }];

      const result = await this.provider.sendMessage({
        model: config.model,
        system: `You are Meridian, a personal AI assistant. You are the Doorman — the user-facing front-door to a multi-agent system.

Your role RIGHT NOW is casual conversation only. You are NOT executing tasks in this context — you're just chatting.

When the user asks you to DO something (code, research, write, check files, run commands), you should tell them to just describe the task and you'll delegate it to a specialist agent. You do NOT do the work yourself. You do NOT have access to files, tools, shell, or databases in this chat mode.

What happens behind the scenes (don't over-explain):
- Task messages get routed to specialist agents (coder, researcher, writer)
- Agents can use Claude Code CLI for real coding/file tasks
- The user can say "status" to check progress, "stop" to cancel

For conversation, reply warmly and concisely (1-3 sentences). Be natural — like a capable friend who knows when to hand off work to the right specialist.${systemCtx}`,
        messages,
        maxTokens: 256,
      });
      await this.respond(result.content || 'Sorry, I couldn\'t generate a response.');
    } catch (err) {
      logger.error({ err }, 'Doorman chat error');
      await this.respond('Sorry, something went wrong. Try again or send me a task.');
    }
  }

  private async respondStatus(): Promise<void> {
    const state = this.blackboard.getState();
    const running = state.agents.filter(a => a.status === 'working');
    const pendingTasks = state.tasks.filter(t => t.status === 'pending');
    const runningTasks = state.tasks.filter(t => t.status === 'running');
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

    // Mention scheduled tasks if any
    const scheduledTasks = state.tasks.filter(t => t.source === 'scheduler');
    if (scheduledTasks.length > 0) {
      const recentScheduled = scheduledTasks.filter(t => t.status === 'completed').slice(0, 3);
      if (recentScheduled.length > 0) {
        status += `\n\nRecent scheduled tasks: ${recentScheduled.map(t => t.prompt.slice(0, 40)).join(', ')}`;
      }
    }

    await this.respond(status);
  }

  private async handleKill(targetId?: string): Promise<void> {
    const running = this.registry.getRunning();
    if (running.length === 0) {
      await this.respond('Nothing running right now.');
      return;
    }
    if (targetId) {
      this.runner.killAgent(targetId);
      await this.respond('Done, stopped it.');
    } else {
      this.runner.killAll();
      await this.respond(`Stopped all ${running.length} running task${running.length > 1 ? 's' : ''}.`);
    }
  }

  private async handleApproval(approve: boolean, approvalId?: string): Promise<void> {
    if (!approvalId) {
      await this.respond('No pending approvals.');
      return;
    }
    this.blackboard.resolveApproval(approvalId, approve ? 'approved' : 'rejected');
    await this.respond(`Approval ${approve ? 'approved' : 'rejected'}.`);
  }

  private async delegateTask(prompt: string, role: AgentRole, executor?: string, continueFrom?: string): Promise<void> {
    let parentTaskId: string | undefined;
    let sessionId: string | undefined;

    // Link to previous task for multi-turn continuity
    if (continueFrom === 'latest') {
      const allTasks = this.blackboard.getAllTasks();
      const prev = allTasks.find(t =>
        t.status === 'completed' && t.sessionId && t.executor === 'claude-code'
      );
      if (prev) {
        parentTaskId = prev.id;
        sessionId = prev.sessionId!;
        executor = 'claude-code'; // force same executor
        logger.info({ parentTaskId, sessionId }, 'Continuing from previous session');
      }
    }

    // For system introspection tasks, enrich prompt with Meridian internals
    let enrichedPrompt = prompt;
    if (executor === 'claude-code' && /\b(blackboard|database|sqlite|system.?check|self.?check|diagnos|state|db)\b/i.test(prompt)) {
      enrichedPrompt = `${prompt}\n\nContext: Meridian's blackboard is a SQLite database at ${config.dataDir}/meridian.db. Tables: tasks, agents, feeds, approvals. Use sqlite3 CLI or read the schema to answer. Project root: ${process.cwd()}`;
    }

    const task: Task = {
      id: crypto.randomUUID(),
      prompt: enrichedPrompt,
      role,
      status: 'pending',
      agentId: null,
      result: null,
      error: null,
      executor: executor || undefined,
      parentTaskId,
      sessionId,
      source: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.blackboard.createTask(task);
    // Runner reacts to task:created synchronously via drainPending —
    // check whether it already picked this task up
    const updated = this.blackboard.getTask(task.id);
    const resumeNote = parentTaskId ? ' (resuming session)' : '';

    if (updated && updated.status === 'running') {
      await this.respond(`On it${resumeNote}. I'll send you the result when it's done.`);
    } else {
      await this.respond(`Noted${resumeNote}. All agents are busy — I'll start this as soon as one frees up.`);
    }
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
