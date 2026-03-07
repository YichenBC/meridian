import Database from 'better-sqlite3';
import type { Task, AgentInfo, FeedEntry, Approval, Note } from '../types.js';

let db: Database.Database;

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      agentId TEXT,
      result TEXT,
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      currentTaskId TEXT,
      pid INTEGER,
      startedAt TEXT NOT NULL,
      lastActivityAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      taskId TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt TEXT NOT NULL,
      resolvedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      taskId TEXT,
      createdAt TEXT NOT NULL
    );
  `);

  // Migration: rename specialistId → agentId if old column exists
  try {
    db.exec(`ALTER TABLE tasks RENAME COLUMN specialistId TO agentId`);
  } catch { /* column already named agentId or doesn't exist */ }

  // Migration: add executor/outputBytes to agents
  try { db.exec(`ALTER TABLE agents ADD COLUMN executor TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN outputBytes INTEGER DEFAULT 0`); } catch { /* already exists */ }

  // Migration: add parentTaskId/sessionId/executor to tasks
  try { db.exec(`ALTER TABLE tasks ADD COLUMN parentTaskId TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN sessionId TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN executor TEXT`); } catch { /* already exists */ }

  // Migration: add source to tasks
  try { db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT`); } catch { /* already exists */ }

  // Migration: add model to tasks (per-agent model selection)
  try { db.exec(`ALTER TABLE tasks ADD COLUMN model TEXT`); } catch { /* already exists */ }

  // Migration: add persistent to agents
  try { db.exec(`ALTER TABLE agents ADD COLUMN persistent INTEGER DEFAULT 0`); } catch { /* already exists */ }

  // Migration: add blockedBy (JSON array) and priority to tasks
  try { db.exec(`ALTER TABLE tasks ADD COLUMN blockedBy TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0`); } catch { /* already exists */ }
}

export function initDatabase(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
}

// --- Tasks ---

export function createTask(task: Task): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, prompt, role, status, agentId, result, error, createdAt, updatedAt, parentTaskId, sessionId, executor, model, source, blockedBy, priority)
    VALUES (@id, @prompt, @role, @status, @agentId, @result, @error, @createdAt, @updatedAt, @parentTaskId, @sessionId, @executor, @model, @source, @blockedBy, @priority)
  `);
  stmt.run({
    parentTaskId: null, sessionId: null, executor: null, model: null, source: null, priority: 0,
    ...task,
    blockedBy: task.blockedBy ? JSON.stringify(task.blockedBy) : null,
  });
}

function hydrateTask(row: any): Task {
  if (row && typeof row.blockedBy === 'string') {
    try { row.blockedBy = JSON.parse(row.blockedBy); } catch { row.blockedBy = undefined; }
  } else if (row) {
    row.blockedBy = row.blockedBy || undefined;
  }
  return row as Task;
}

export function getTask(id: string): Task | undefined {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(id);
  return row ? hydrateTask(row) : undefined;
}

export function getAllTasks(): Task[] {
  const stmt = db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC');
  return (stmt.all() as any[]).map(hydrateTask);
}

/**
 * Atomically claim a pending task by setting status to 'running'.
 * Returns true if the task was pending and is now claimed, false otherwise.
 */
export function claimTask(id: string): boolean {
  const stmt = db.prepare("UPDATE tasks SET status = 'running', updatedAt = ? WHERE id = ? AND status = 'pending'");
  const result = stmt.run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function updateTask(id: string, updates: Partial<Task>): void {
  const current = getTask(id);
  if (!current) return;

  const merged = {
    parentTaskId: null, sessionId: null, executor: null, model: null, source: null, priority: 0,
    ...current, ...updates, id,
    blockedBy: (updates.blockedBy !== undefined ? updates.blockedBy : current.blockedBy)
      ? JSON.stringify(updates.blockedBy !== undefined ? updates.blockedBy : current.blockedBy)
      : null,
  };
  const stmt = db.prepare(`
    UPDATE tasks SET
      prompt = @prompt,
      role = @role,
      status = @status,
      agentId = @agentId,
      result = @result,
      error = @error,
      createdAt = @createdAt,
      updatedAt = @updatedAt,
      parentTaskId = @parentTaskId,
      sessionId = @sessionId,
      executor = @executor,
      model = @model,
      source = @source,
      blockedBy = @blockedBy,
      priority = @priority
    WHERE id = @id
  `);
  stmt.run(merged);
}

// --- Agents ---

export function createAgent(agent: AgentInfo): void {
  const stmt = db.prepare(`
    INSERT INTO agents (id, role, status, currentTaskId, pid, startedAt, lastActivityAt, executor, outputBytes, persistent)
    VALUES (@id, @role, @status, @currentTaskId, @pid, @startedAt, @lastActivityAt, @executor, @outputBytes, @persistent)
  `);
  stmt.run({ executor: null, outputBytes: 0, ...agent, persistent: agent.persistent ? 1 : 0 });
}

export function getAgent(id: string): AgentInfo | undefined {
  const stmt = db.prepare('SELECT * FROM agents WHERE id = ?');
  return stmt.get(id) as AgentInfo | undefined;
}

export function getAllAgents(): AgentInfo[] {
  const stmt = db.prepare('SELECT * FROM agents ORDER BY startedAt DESC');
  return stmt.all() as AgentInfo[];
}

export function updateAgent(id: string, updates: Partial<AgentInfo>): void {
  const current = getAgent(id);
  if (!current) return;

  const merged = { executor: null, outputBytes: 0, persistent: 0, ...current, ...updates, id };
  const stmt = db.prepare(`
    UPDATE agents SET
      role = @role,
      status = @status,
      currentTaskId = @currentTaskId,
      pid = @pid,
      startedAt = @startedAt,
      lastActivityAt = @lastActivityAt,
      executor = @executor,
      outputBytes = @outputBytes,
      persistent = @persistent
    WHERE id = @id
  `);
  stmt.run(merged);
}

export function removeAgent(id: string): void {
  const stmt = db.prepare('DELETE FROM agents WHERE id = ?');
  stmt.run(id);
}

// --- Feeds ---

export function addFeed(entry: FeedEntry): void {
  const stmt = db.prepare(`
    INSERT INTO feeds (id, type, source, content, taskId, timestamp)
    VALUES (@id, @type, @source, @content, @taskId, @timestamp)
  `);
  stmt.run(entry);
}

export function getFeeds(limit: number = 100): FeedEntry[] {
  const stmt = db.prepare('SELECT * FROM feeds ORDER BY timestamp DESC LIMIT ?');
  return stmt.all(limit) as FeedEntry[];
}

export function getFeedsByTask(taskId: string, type?: string, limit: number = 20): FeedEntry[] {
  if (type) {
    const stmt = db.prepare('SELECT * FROM feeds WHERE taskId = ? AND type = ? ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(taskId, type, limit) as FeedEntry[];
  }
  const stmt = db.prepare('SELECT * FROM feeds WHERE taskId = ? ORDER BY timestamp DESC LIMIT ?');
  return stmt.all(taskId, limit) as FeedEntry[];
}

/**
 * Delete old feed entries, keeping only the most recent `keepCount`.
 * Returns the number of deleted rows.
 */
export function rotateFeeds(keepCount: number = 5000): number {
  const stmt = db.prepare(`
    DELETE FROM feeds WHERE id NOT IN (
      SELECT id FROM feeds ORDER BY timestamp DESC LIMIT ?
    )
  `);
  const result = stmt.run(keepCount);
  return result.changes;
}

/**
 * Check whether all blockers for a task are completed.
 */
export function areBlockersComplete(blockedBy: string[]): boolean {
  if (blockedBy.length === 0) return true;
  const placeholders = blockedBy.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`
  );
  const row = stmt.get(...blockedBy) as { cnt: number };
  return row.cnt === blockedBy.length;
}

// --- Approvals ---

export function createApproval(approval: Approval): void {
  const stmt = db.prepare(`
    INSERT INTO approvals (id, taskId, description, status, createdAt, resolvedAt)
    VALUES (@id, @taskId, @description, @status, @createdAt, @resolvedAt)
  `);
  stmt.run(approval);
}

export function getApproval(id: string): Approval | undefined {
  const stmt = db.prepare('SELECT * FROM approvals WHERE id = ?');
  return stmt.get(id) as Approval | undefined;
}

export function getPendingApprovals(): Approval[] {
  const stmt = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY createdAt DESC");
  return stmt.all() as Approval[];
}

export function resolveApproval(id: string, status: 'approved' | 'rejected'): void {
  const stmt = db.prepare(`
    UPDATE approvals SET status = ?, resolvedAt = ? WHERE id = ?
  `);
  stmt.run(status, new Date().toISOString(), id);
}

// --- Notes ---

export function createNote(note: Note): void {
  const stmt = db.prepare(`
    INSERT INTO notes (id, source, title, content, tags, taskId, createdAt)
    VALUES (@id, @source, @title, @content, @tags, @taskId, @createdAt)
  `);
  stmt.run({ tags: null, taskId: null, ...note });
}

export function getNote(id: string): Note | undefined {
  const stmt = db.prepare('SELECT * FROM notes WHERE id = ?');
  return stmt.get(id) as Note | undefined;
}

export function getNotes(limit: number = 50): Note[] {
  const stmt = db.prepare('SELECT * FROM notes ORDER BY createdAt DESC LIMIT ?');
  return stmt.all(limit) as Note[];
}

export function getNotesByTask(taskId: string): Note[] {
  const stmt = db.prepare('SELECT * FROM notes WHERE taskId = ? ORDER BY createdAt DESC');
  return stmt.all(taskId) as Note[];
}

export function getNotesByTag(tag: string): Note[] {
  const escaped = tag.replace(/[%_]/g, '\\$&');
  const stmt = db.prepare("SELECT * FROM notes WHERE tags LIKE ? ESCAPE '\\' ORDER BY createdAt DESC");
  return stmt.all(`%${escaped}%`) as Note[];
}
