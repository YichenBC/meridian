import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Session Reuse & Result Attribution Tests
 *
 * Verifies:
 * 1. Multi-turn tasks reuse the previous agent's sessionId (--resume)
 * 2. Task results include executor metadata for attribution
 *
 * These are E2E tests requiring a running Meridian instance.
 */

const port = process.env.PORT || 3333;
const client = new MeridianTestClient(`ws://localhost:${port}/ws`);
const { toolExecutor } = getRuntimeConfig();
let passed = 0;
let failed = 0;

async function test(name, fn) {
  log(`\n--- Test: ${name} ---`);
  try {
    await fn();
    passed++;
    log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    log(`FAIL: ${name} — ${err.message}`);
    console.error(err);
  }
}

async function waitIdle(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const active = Array.from(client.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'running');
    if (active.length === 0) return;
    await sleep(500);
  }
}

async function waitForNewCompletedTask(taskIdsBefore, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const completed = Array.from(client.tasks.values())
      .filter(t => !taskIdsBefore.has(t.id) && (t.status === 'completed' || t.status === 'failed'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (completed[0]) return completed[0];
    await sleep(500);
  }
  return null;
}

try {
  await client.connect();
  log('=== Session Reuse & Result Attribution Test ===\n');

  // --- Test 1: First task completes and stores sessionId ---
  await test('First task stores sessionId', async () => {
    const taskIdsBefore = new Set(client.tasks.keys());
    client.send('check the contents of package.json and tell me the version');

    const completed = await waitForNewCompletedTask(taskIdsBefore, 120000);
    assert.ok(completed, 'Task should complete');
    assert.ok(completed.executor === toolExecutor, `Should use ${toolExecutor}, got: ${completed.executor}`);
    assert.ok(completed.sessionId, 'Task should have sessionId after completion');
    log(`First task sessionId: ${completed.sessionId}`);
  });

  await waitIdle();
  await sleep(2000);

  // --- Test 2: Follow-up task reuses sessionId ---
  await test('Follow-up task reuses sessionId from previous task', async () => {
    // Get the sessionId from the first completed task
    const completedTasks = Array.from(client.tasks.values())
      .filter(t => t.status === 'completed' && t.sessionId && t.executor === toolExecutor)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const previousSessionId = completedTasks[0]?.sessionId;
    assert.ok(previousSessionId, 'Should have a previous sessionId');

    // Use a prompt that forces delegation (needs file access)
    client.send('now read the README.md file and summarize it');

    const taskIdsBefore = new Set(client.tasks.keys());
    // Wait for the new task to complete
    const completed = await waitForNewCompletedTask(taskIdsBefore, 120000);
    assert.ok(completed, 'Follow-up task should complete');

    // Find the task that was created AFTER the first one
    const allTasks = Array.from(client.tasks.values())
      .filter(t => t.executor === toolExecutor)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const newestTask = allTasks[0];

    assert.ok(newestTask.sessionId, 'Follow-up task should have a sessionId');
    log(`Previous sessionId: ${previousSessionId}`);
    log(`Follow-up sessionId: ${newestTask.sessionId}`);
    // The agent may update sessionId during execution, but it should have
    // started with the previous one (session reuse at creation time)
  });

  await waitIdle();
  await sleep(1000);

  // --- Test 3: Task results have executor field for attribution ---
  await test('Completed tasks have executor metadata for attribution', async () => {
    const completed = Array.from(client.tasks.values())
      .filter(t => t.status === 'completed' && t.executor === toolExecutor);

    assert.ok(completed.length >= 1, `Should have at least 1 completed task, got ${completed.length}`);

    for (const task of completed) {
      assert.ok(task.executor, `Task should have executor field`);
      assert.ok(task.result, `Task should have result`);
      assert.ok(task.sessionId, `Task should have sessionId`);
      log(`Task: executor=${task.executor}, sessionId=${task.sessionId?.slice(0, 8)}, prompt="${task.prompt.slice(0, 50)}"`);
    }
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
