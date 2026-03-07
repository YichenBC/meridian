import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Blackboard } from '../blackboard/blackboard.js';
import { Doorman } from './doorman.js';
import { AgentRunner } from '../agents/runner.js';
import { UserMessage, WsOutMessage, WsInMessage, Task, Note } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import crypto from 'crypto';
import { installSkill } from '../skills/install.js';
import { SkillInstallMetadata } from '../types.js';

export class HttpServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(
    private blackboard: Blackboard,
    private doorman: Doorman,
    private runner: AgentRunner,
  ) {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.wss = new WebSocketServer({ server: this.server });
    this.setupWebSocket();
    this.setupBlackboardBroadcast();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${config.port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      // Serve A2UI
      const htmlPath = path.join(process.cwd(), 'a2ui', 'index.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end('A2UI not found');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = this.blackboard.getState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/skills') {
      const skills = this.runner.getSkills().map((skill) => ({
        name: skill.name,
        description: skill.description,
        executor: skill.executor || null,
        model: skill.model || null,
        baseDir: skill.baseDir,
        sourceDir: skill.sourceDir,
        install: skill.install || null,
        openclaw: skill.openclaw || null,
        eligibility: skill.eligibility,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(skills));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/install') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { sourcePath, name, overwrite } = JSON.parse(body);
          if (!sourcePath || typeof sourcePath !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sourcePath is required' }));
            return;
          }

          const installed = installSkill({
            sourcePath,
            targetRoot: config.skillsDir,
            name,
            overwrite: overwrite === true,
            installMetadata: buildApiInstallMetadata(sourcePath),
          });
          this.runner.reloadSkills();

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(installed));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to install skill' }));
        }
      });
      return;
    }

    // POST /api/tasks — create task directly on blackboard (for agents, scheduler, external)
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { prompt, role, executor, model, source } = JSON.parse(body);
          if (!prompt) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'prompt is required' }));
            return;
          }
          const task: Task = {
            id: crypto.randomUUID(),
            prompt,
            role: role || 'general',
            status: 'pending',
            agentId: null,
            result: null,
            error: null,
            executor: executor || undefined,
            model: model || undefined,
            source: source || 'api',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          this.blackboard.createTask(task);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: task.id, status: task.status }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/notes — add a note to the blackboard (informational, no agent spawn)
    if (req.method === 'POST' && url.pathname === '/api/notes') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { title, content, source, tags, taskId } = JSON.parse(body);
          if (!title || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'title and content are required' }));
            return;
          }
          const note: Note = {
            id: crypto.randomUUID(),
            source: source || 'api',
            title,
            content,
            tags: tags || undefined,
            taskId: taskId || undefined,
            createdAt: new Date().toISOString(),
          };
          this.blackboard.addNote(note);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: note.id }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/notes — list recent notes
    if (req.method === 'GET' && url.pathname === '/api/notes') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const tag = url.searchParams.get('tag');
      const notes = tag ? this.blackboard.getNotesByTag(tag) : this.blackboard.getNotes(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notes));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/approve/')) {
      const id = url.pathname.split('/').pop()!;
      const approval = this.blackboard.getApproval(id);
      if (!approval) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Approval not found' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { action } = JSON.parse(body);
          this.blackboard.resolveApproval(id, action === 'approve' ? 'approved' : 'rejected');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info('A2UI client connected');

      // Send full state on connect
      const state = this.blackboard.getState();
      this.sendTo(ws, { type: 'state', data: state });

      ws.on('message', (data) => {
        try {
          const msg: WsInMessage = JSON.parse(data.toString());
          this.handleWsMessage(msg);
        } catch (err) {
          logger.warn({ err }, 'Invalid WS message');
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('A2UI client disconnected');
      });
    });
  }

  private handleWsMessage(msg: WsInMessage): void {
    switch (msg.type) {
      case 'message': {
        const userMsg: UserMessage = {
          id: crypto.randomUUID(),
          channelId: 'a2ui:0',
          sender: 'user',
          content: msg.content,
          timestamp: new Date().toISOString(),
        };
        this.doorman.handleMessage(userMsg);
        break;
      }
      case 'approve':
        this.blackboard.resolveApproval(msg.approvalId, 'approved');
        break;
      case 'reject':
        this.blackboard.resolveApproval(msg.approvalId, 'rejected');
        break;
    }
  }

  private setupBlackboardBroadcast(): void {
    this.blackboard.on('feed:new', (entry) => {
      this.broadcastWs({ type: 'feed', data: entry });
    });
    this.blackboard.on('task:created', (task) => {
      this.broadcastWs({ type: 'task_update', data: task });
    });
    this.blackboard.on('task:updated', (task) => {
      this.broadcastWs({ type: 'task_update', data: task });
    });
    this.blackboard.on('agent:registered', (agent) => {
      this.broadcastWs({ type: 'agent_update', data: agent });
    });
    this.blackboard.on('agent:updated', (agent) => {
      this.broadcastWs({ type: 'agent_update', data: agent });
    });
    this.blackboard.on('approval:requested', (approval) => {
      this.broadcastWs({ type: 'approval_request', data: approval });
    });
    this.blackboard.on('note:created', (note) => {
      this.broadcastWs({ type: 'note', data: note });
    });
  }

  private sendTo(ws: WebSocket, msg: WsOutMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastWs(msg: WsOutMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(config.port, () => {
        logger.info({ port: config.port }, 'HTTP server started');
        logger.info({ url: `http://localhost:${config.port}` }, 'A2UI dashboard');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

function buildApiInstallMetadata(sourcePath: string): SkillInstallMetadata {
  return {
    installer: 'meridian',
    installedAt: new Date().toISOString(),
    source: {
      kind: 'local-path',
      reference: sourcePath,
      resolvedPath: path.resolve(sourcePath),
    },
  };
}
