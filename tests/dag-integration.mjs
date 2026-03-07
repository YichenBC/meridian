import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach } from 'node:test';

const { initDatabase, createTask, getTask, updateTask, claimTask, areBlockersComplete, getAllTasks } = await import('../dist/blackboard/db.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-dag-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

const now = () => new Date().toISOString();

function makeTask(overrides = {}) {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    prompt: 'test',
    role: 'general',
    status: 'pending',
    agentId: null,
    result: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

/**
 * Simulate the runner's drainPending logic:
 * - Get pending tasks sorted by priority (desc) then createdAt (asc)
 * - Skip tasks with incomplete blockers
 * - Claim up to maxSlots tasks
 * Returns claimed task IDs.
 */
function simulateDrain(maxSlots) {
  const pending = getAllTasks()
    .filter(t => t.status === 'pending')
    .sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.createdAt.localeCompare(b.createdAt);
    });

  const claimed = [];
  for (const task of pending) {
    if (claimed.length >= maxSlots) break;
    if (task.blockedBy && task.blockedBy.length > 0) {
      if (!areBlockersComplete(task.blockedBy)) continue;
    }
    if (claimTask(task.id)) {
      claimed.push(task.id);
    }
  }
  return claimed;
}

function completeTask(id, result = 'done') {
  updateTask(id, { status: 'completed', result, updatedAt: now() });
}

// ─── DAG Integration: simulates runner behavior ────────────────────────

describe('DAG integration (simulated runner)', () => {
  beforeEach(() => freshDb());

  it('executes independent tasks in parallel', () => {
    createTask(makeTask({ id: 'a', prompt: 'task A' }));
    createTask(makeTask({ id: 'b', prompt: 'task B' }));
    createTask(makeTask({ id: 'c', prompt: 'task C' }));

    const claimed = simulateDrain(3);
    assert.equal(claimed.length, 3);
    assert.deepEqual(claimed.sort(), ['a', 'b', 'c']);
  });

  it('blocks dependent task until blocker completes', () => {
    createTask(makeTask({ id: 'research', prompt: 'do research' }));
    createTask(makeTask({ id: 'write', prompt: 'write report', blockedBy: ['research'] }));

    // Wave 1: only research should be claimed
    const wave1 = simulateDrain(3);
    assert.deepEqual(wave1, ['research']);
    assert.equal(getTask('write').status, 'pending');

    // Complete research
    completeTask('research', 'findings here');

    // Wave 2: write should now be unblocked
    const wave2 = simulateDrain(3);
    assert.deepEqual(wave2, ['write']);
  });

  it('handles diamond DAG (A -> B, A -> C, B+C -> D)', () => {
    const t = (id) => now(); // all same time, rely on insertion order
    createTask(makeTask({ id: 'A', prompt: 'foundation', createdAt: '2026-01-01T00:00:00Z' }));
    createTask(makeTask({ id: 'B', prompt: 'branch 1', blockedBy: ['A'], createdAt: '2026-01-01T00:00:01Z' }));
    createTask(makeTask({ id: 'C', prompt: 'branch 2', blockedBy: ['A'], createdAt: '2026-01-01T00:00:02Z' }));
    createTask(makeTask({ id: 'D', prompt: 'merge', blockedBy: ['B', 'C'], createdAt: '2026-01-01T00:00:03Z' }));

    // Wave 1: only A
    const w1 = simulateDrain(3);
    assert.deepEqual(w1, ['A']);

    completeTask('A');

    // Wave 2: B and C (both unblocked now)
    const w2 = simulateDrain(3);
    assert.equal(w2.length, 2);
    assert.ok(w2.includes('B'));
    assert.ok(w2.includes('C'));

    // D still blocked
    assert.equal(getTask('D').status, 'pending');

    completeTask('B');
    // Wave 3: D still blocked (C not done)
    const w3 = simulateDrain(3);
    assert.equal(w3.length, 0);

    completeTask('C');
    // Wave 4: D unblocked
    const w4 = simulateDrain(3);
    assert.deepEqual(w4, ['D']);
  });

  it('respects priority within same wave', () => {
    createTask(makeTask({ id: 'low', prompt: 'low prio', priority: 1, createdAt: '2026-01-01T00:00:00Z' }));
    createTask(makeTask({ id: 'high', prompt: 'high prio', priority: 10, createdAt: '2026-01-01T00:00:01Z' }));
    createTask(makeTask({ id: 'mid', prompt: 'mid prio', priority: 5, createdAt: '2026-01-01T00:00:02Z' }));

    // With only 1 slot, should pick highest priority first
    const w1 = simulateDrain(1);
    assert.deepEqual(w1, ['high']);

    const w2 = simulateDrain(1);
    assert.deepEqual(w2, ['mid']);

    const w3 = simulateDrain(1);
    assert.deepEqual(w3, ['low']);
  });

  it('respects slot limits', () => {
    for (let i = 0; i < 10; i++) {
      createTask(makeTask({ id: `t${i}` }));
    }
    const claimed = simulateDrain(3);
    assert.equal(claimed.length, 3);
  });

  it('handles chain: A -> B -> C -> D (sequential pipeline)', () => {
    createTask(makeTask({ id: 'step1', createdAt: '2026-01-01T00:00:00Z' }));
    createTask(makeTask({ id: 'step2', blockedBy: ['step1'], createdAt: '2026-01-01T00:00:01Z' }));
    createTask(makeTask({ id: 'step3', blockedBy: ['step2'], createdAt: '2026-01-01T00:00:02Z' }));
    createTask(makeTask({ id: 'step4', blockedBy: ['step3'], createdAt: '2026-01-01T00:00:03Z' }));

    let wave;
    wave = simulateDrain(3);
    assert.deepEqual(wave, ['step1']);

    completeTask('step1');
    wave = simulateDrain(3);
    assert.deepEqual(wave, ['step2']);

    completeTask('step2');
    wave = simulateDrain(3);
    assert.deepEqual(wave, ['step3']);

    completeTask('step3');
    wave = simulateDrain(3);
    assert.deepEqual(wave, ['step4']);
  });

  it('failed blocker blocks dependent forever', () => {
    createTask(makeTask({ id: 'fail-parent' }));
    createTask(makeTask({ id: 'fail-child', blockedBy: ['fail-parent'] }));

    simulateDrain(3); // claims fail-parent
    updateTask('fail-parent', { status: 'failed', error: 'boom' });

    // Child stays blocked since parent is failed, not completed
    const wave = simulateDrain(3);
    assert.equal(wave.length, 0);
    assert.equal(getTask('fail-child').status, 'pending');
  });

  it('cancelled blocker blocks dependent', () => {
    createTask(makeTask({ id: 'cancel-parent' }));
    createTask(makeTask({ id: 'cancel-child', blockedBy: ['cancel-parent'] }));

    simulateDrain(3);
    updateTask('cancel-parent', { status: 'cancelled' });

    const wave = simulateDrain(3);
    assert.equal(wave.length, 0);
  });
});
