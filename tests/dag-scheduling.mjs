import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach } from 'node:test';

// Use compiled output
const { initDatabase, createTask, getTask, getAllTasks, updateTask, claimTask, areBlockersComplete } = await import('../dist/blackboard/db.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

function makeTask(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    prompt: 'test task',
    role: 'general',
    status: 'pending',
    agentId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Task DAG: blockedBy field ─────────────────────────────────────────

describe('Task DAG (blockedBy)', () => {
  beforeEach(() => freshDb());

  it('creates and retrieves a task with no blockers', () => {
    const task = makeTask({ id: 'solo-1' });
    createTask(task);
    const retrieved = getTask('solo-1');
    assert.equal(retrieved.status, 'pending');
    assert.equal(retrieved.blockedBy, undefined);
  });

  it('creates a task with blockedBy and retrieves as array', () => {
    const parent = makeTask({ id: 'parent-1' });
    const child = makeTask({ id: 'child-1', blockedBy: ['parent-1'] });
    createTask(parent);
    createTask(child);

    const retrieved = getTask('child-1');
    assert.deepEqual(retrieved.blockedBy, ['parent-1']);
  });

  it('stores multiple blockers', () => {
    createTask(makeTask({ id: 'a' }));
    createTask(makeTask({ id: 'b' }));
    createTask(makeTask({ id: 'c', blockedBy: ['a', 'b'] }));

    const retrieved = getTask('c');
    assert.deepEqual(retrieved.blockedBy, ['a', 'b']);
  });

  it('updates blockedBy via updateTask', () => {
    createTask(makeTask({ id: 't1', blockedBy: ['x'] }));
    updateTask('t1', { blockedBy: ['x', 'y'] });
    const retrieved = getTask('t1');
    assert.deepEqual(retrieved.blockedBy, ['x', 'y']);
  });

  it('clears blockedBy when set to empty array', () => {
    createTask(makeTask({ id: 't2', blockedBy: ['x'] }));
    updateTask('t2', { blockedBy: [] });
    const retrieved = getTask('t2');
    // Empty array or undefined both acceptable
    assert.ok(!retrieved.blockedBy || retrieved.blockedBy.length === 0);
  });

  it('getAllTasks hydrates blockedBy for all tasks', () => {
    createTask(makeTask({ id: 'p1' }));
    createTask(makeTask({ id: 'p2' }));
    createTask(makeTask({ id: 'c1', blockedBy: ['p1', 'p2'] }));

    const all = getAllTasks();
    const c1 = all.find(t => t.id === 'c1');
    assert.deepEqual(c1.blockedBy, ['p1', 'p2']);
  });
});

// ─── areBlockersComplete ───────────────────────────────────────────────

describe('areBlockersComplete', () => {
  beforeEach(() => freshDb());

  it('returns true for empty blockers', () => {
    assert.equal(areBlockersComplete([]), true);
  });

  it('returns false when blocker is pending', () => {
    createTask(makeTask({ id: 'blocker-1', status: 'pending' }));
    assert.equal(areBlockersComplete(['blocker-1']), false);
  });

  it('returns false when blocker is running', () => {
    createTask(makeTask({ id: 'blocker-2', status: 'running' }));
    assert.equal(areBlockersComplete(['blocker-2']), false);
  });

  it('returns true when blocker is completed', () => {
    createTask(makeTask({ id: 'blocker-3', status: 'completed', result: 'done' }));
    assert.equal(areBlockersComplete(['blocker-3']), true);
  });

  it('returns false when one of multiple blockers is incomplete', () => {
    createTask(makeTask({ id: 'b-a', status: 'completed', result: 'done' }));
    createTask(makeTask({ id: 'b-b', status: 'running' }));
    assert.equal(areBlockersComplete(['b-a', 'b-b']), false);
  });

  it('returns true when all multiple blockers are completed', () => {
    createTask(makeTask({ id: 'b-x', status: 'completed', result: 'done' }));
    createTask(makeTask({ id: 'b-y', status: 'completed', result: 'done' }));
    assert.equal(areBlockersComplete(['b-x', 'b-y']), true);
  });

  it('returns false when blocker does not exist', () => {
    assert.equal(areBlockersComplete(['nonexistent']), false);
  });
});

// ─── Priority ordering ────────────────────────────────────────────────

describe('Task priority', () => {
  beforeEach(() => freshDb());

  it('stores and retrieves priority', () => {
    createTask(makeTask({ id: 'hp', priority: 10 }));
    const t = getTask('hp');
    assert.equal(t.priority, 10);
  });

  it('defaults priority to 0', () => {
    createTask(makeTask({ id: 'dp' }));
    const t = getTask('dp');
    assert.equal(t.priority, 0);
  });
});

// ─── claimTask atomicity ──────────────────────────────────────────────

describe('claimTask', () => {
  beforeEach(() => freshDb());

  it('claims a pending task and returns true', () => {
    createTask(makeTask({ id: 'claim-1' }));
    assert.equal(claimTask('claim-1'), true);
    assert.equal(getTask('claim-1').status, 'running');
  });

  it('returns false for already-running task', () => {
    createTask(makeTask({ id: 'claim-2' }));
    claimTask('claim-2');
    assert.equal(claimTask('claim-2'), false);
  });

  it('returns false for completed task', () => {
    createTask(makeTask({ id: 'claim-3', status: 'completed' }));
    assert.equal(claimTask('claim-3'), false);
  });

  it('returns false for nonexistent task', () => {
    assert.equal(claimTask('nope'), false);
  });
});
