import { EventEmitter } from 'events';
import {
  Task,
  AgentInfo,
  FeedEntry,
  Approval,
  Note,
  BlackboardState,
} from '../types.js';
import * as db from './db.js';
import { logger } from '../logger.js';

export class Blackboard extends EventEmitter {
  constructor(dbPath: string) {
    super();
    db.initDatabase(dbPath);
    this.cleanupStaleState();
    // Rotate old feed entries on startup to prevent unbounded growth
    const deleted = db.rotateFeeds(5000);
    if (deleted > 0) {
      logger.info({ deleted }, 'Rotated old feed entries');
    }
  }

  /**
   * On startup, mark any leftover "working" agents as stopped
   * and their tasks as failed. These are remnants of a crashed session.
   */
  private cleanupStaleState(): void {
    const staleAgents = db.getAllAgents().filter(a => a.status === 'working' || a.status === 'idle');
    for (const agent of staleAgents) {
      if (agent.currentTaskId) {
        db.updateTask(agent.currentTaskId, { status: 'failed', error: 'Interrupted by restart' });
      }
      db.removeAgent(agent.id);
    }
    if (staleAgents.length > 0) {
      logger.info({ count: staleAgents.length }, 'Cleaned up stale agents from previous session');
    }
  }

  // --- Task operations ---

  createTask(task: Task): void {
    db.createTask(task);
    this.emit('task:created', task);
  }

  getTask(id: string): Task | undefined {
    return db.getTask(id);
  }

  getAllTasks(): Task[] {
    return db.getAllTasks();
  }

  claimTask(id: string): boolean {
    return db.claimTask(id);
  }

  updateTask(id: string, updates: Partial<Task>): void {
    db.updateTask(id, updates);
    const updated = db.getTask(id);
    if (updated) {
      this.emit('task:updated', updated);
    }
  }

  // --- Agent operations ---

  registerAgent(agent: AgentInfo): void {
    db.createAgent(agent);
    this.emit('agent:registered', agent);
  }

  getAgent(id: string): AgentInfo | undefined {
    return db.getAgent(id);
  }

  getAllAgents(): AgentInfo[] {
    return db.getAllAgents();
  }

  updateAgent(id: string, updates: Partial<AgentInfo>): void {
    db.updateAgent(id, updates);
    const updated = db.getAgent(id);
    if (updated) {
      this.emit('agent:updated', updated);
    }
  }

  removeAgent(id: string): void {
    db.removeAgent(id);
    this.emit('agent:removed', id);
  }

  areBlockersComplete(blockedBy: string[]): boolean {
    return db.areBlockersComplete(blockedBy);
  }

  // --- Feed ---

  addFeed(entry: FeedEntry): void {
    db.addFeed(entry);
    this.emit('feed:new', entry);
  }

  getFeeds(limit?: number): FeedEntry[] {
    return db.getFeeds(limit);
  }

  getTaskFeeds(taskId: string, type?: string, limit?: number): FeedEntry[] {
    return db.getFeedsByTask(taskId, type, limit);
  }

  rotateFeeds(keepCount?: number): number {
    return db.rotateFeeds(keepCount);
  }

  // --- Approvals ---

  requestApproval(approval: Approval): void {
    db.createApproval(approval);
    this.emit('approval:requested', approval);
  }

  getApproval(id: string): Approval | undefined {
    return db.getApproval(id);
  }

  getPendingApprovals(): Approval[] {
    return db.getPendingApprovals();
  }

  resolveApproval(id: string, status: 'approved' | 'rejected'): void {
    db.resolveApproval(id, status);
    const resolved = db.getApproval(id);
    if (resolved) {
      this.emit('approval:resolved', resolved);
    }
  }

  // --- Notes (informational, don't trigger agent spawn) ---

  addNote(note: Note): void {
    db.createNote(note);
    this.emit('note:created', note);
  }

  getNote(id: string): Note | undefined {
    return db.getNote(id);
  }

  getNotes(limit?: number): Note[] {
    return db.getNotes(limit);
  }

  getTaskNotes(taskId: string): Note[] {
    return db.getNotesByTask(taskId);
  }

  getNotesByTag(tag: string): Note[] {
    return db.getNotesByTag(tag);
  }

  // --- State snapshot ---

  getState(): BlackboardState {
    return {
      tasks: db.getAllTasks(),
      agents: db.getAllAgents(),
      feeds: db.getFeeds(),
      approvals: db.getPendingApprovals(),
      notes: db.getNotes(),
    };
  }
}
