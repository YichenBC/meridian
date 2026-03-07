import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

const { initDatabase, createTask, getTask, getAllTasks, updateTask, claimTask, areBlockersComplete, addFeed, getFeeds, rotateFeeds, createNote, getNotes } = await import('../dist/blackboard/db.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `meridian-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
  return dbPath;
}

const now = () => new Date().toISOString();

function makeTask(id, overrides = {}) {
  return {
    id, prompt: `task ${id}`, role: 'general', status: 'pending',
    agentId: null, result: null, error: null,
    createdAt: now(), updatedAt: now(), ...overrides,
  };
}

function makeFeed(id) {
  return {
    id, type: 'system', source: 'bench', content: `entry ${id}`,
    taskId: null, timestamp: now(),
  };
}

function bench(name, fn, iterations = 1000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round(iterations / (elapsed / 1000));
  console.log(`  ${name}: ${elapsed.toFixed(1)}ms for ${iterations} ops (${opsPerSec} ops/s)`);
  return elapsed;
}

// ─── Benchmarks ────────────────────────────────────────────────────────

describe('Blackboard benchmarks', () => {
  it('task creation throughput', () => {
    freshDb();
    bench('createTask', (i) => createTask(makeTask(`t-${i}`)));
  });

  it('task retrieval by ID', () => {
    freshDb();
    for (let i = 0; i < 500; i++) createTask(makeTask(`t-${i}`));
    bench('getTask', (i) => getTask(`t-${i % 500}`), 5000);
  });

  it('getAllTasks with 1000 tasks', () => {
    freshDb();
    for (let i = 0; i < 1000; i++) createTask(makeTask(`t-${i}`));
    bench('getAllTasks (1000)', () => getAllTasks(), 100);
  });

  it('claimTask atomicity under contention simulation', () => {
    freshDb();
    for (let i = 0; i < 1000; i++) createTask(makeTask(`t-${i}`));
    let claimed = 0;
    bench('claimTask', (i) => {
      if (claimTask(`t-${i}`)) claimed++;
    });
    console.log(`  Claimed: ${claimed}/1000`);
  });

  it('areBlockersComplete with varying depth', () => {
    freshDb();
    // Create 100 completed tasks as potential blockers
    for (let i = 0; i < 100; i++) {
      createTask(makeTask(`blocker-${i}`, { status: 'completed', result: 'done' }));
    }

    // Check with 1 blocker
    bench('areBlockersComplete (1 dep)', () => areBlockersComplete(['blocker-0']), 5000);

    // Check with 5 blockers
    bench('areBlockersComplete (5 deps)', () => areBlockersComplete(['blocker-0', 'blocker-1', 'blocker-2', 'blocker-3', 'blocker-4']), 5000);

    // Check with 10 blockers
    bench('areBlockersComplete (10 deps)', () => areBlockersComplete(Array.from({ length: 10 }, (_, i) => `blocker-${i}`)), 5000);
  });

  it('feed rotation with 10000 entries', () => {
    freshDb();
    console.log('  Creating 10000 feed entries...');
    for (let i = 0; i < 10000; i++) addFeed(makeFeed(`f-${i}`));
    bench('rotateFeeds (keep 1000)', () => {
      // After first rotation, subsequent ones are no-ops
    }, 1);
    const start = performance.now();
    const deleted = rotateFeeds(1000);
    const elapsed = performance.now() - start;
    console.log(`  rotateFeeds: deleted ${deleted} in ${elapsed.toFixed(1)}ms`);
  });

  it('DAG drain simulation (100 tasks, diamond pattern)', () => {
    freshDb();
    // Create a wide diamond: 1 root -> 20 parallel -> 1 merge
    createTask(makeTask('root', { createdAt: '2026-01-01T00:00:00Z' }));
    for (let i = 0; i < 20; i++) {
      createTask(makeTask(`mid-${i}`, { blockedBy: ['root'], createdAt: `2026-01-01T00:00:${String(i + 1).padStart(2, '0')}Z` }));
    }
    const midIds = Array.from({ length: 20 }, (_, i) => `mid-${i}`);
    createTask(makeTask('merge', { blockedBy: midIds, createdAt: '2026-01-01T00:01:00Z' }));

    // Simulate full DAG execution
    const start = performance.now();

    // Wave 1: claim root
    claimTask('root');
    updateTask('root', { status: 'completed', result: 'root done' });

    // Wave 2: claim all mid tasks (check blockers + claim)
    for (let i = 0; i < 20; i++) {
      const id = `mid-${i}`;
      if (areBlockersComplete(['root'])) {
        claimTask(id);
      }
    }
    // Complete all mid tasks
    for (let i = 0; i < 20; i++) {
      updateTask(`mid-${i}`, { status: 'completed', result: `mid-${i} done` });
    }

    // Wave 3: merge
    if (areBlockersComplete(midIds)) {
      claimTask('merge');
    }

    const elapsed = performance.now() - start;
    console.log(`  Full diamond DAG (1 -> 20 -> 1): ${elapsed.toFixed(1)}ms`);

    // Verify final state
    const merge = getTask('merge');
    console.log(`  Merge task status: ${merge.status}`);
  });

  it('note creation and retrieval', () => {
    freshDb();
    bench('createNote', (i) => createNote({
      id: `n-${i}`, source: 'bench', title: `Note ${i}`,
      content: 'test content', tags: 'test,bench', createdAt: now(),
    }));
    bench('getNotes (50)', () => getNotes(50), 1000);
  });
});
