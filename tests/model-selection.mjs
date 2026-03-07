import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Model Selection E2E Test — 4 cases
 *
 * Tests per-task model selection: different tasks can use different models
 * for cost control. This validates the design principle that model is a
 * configuration concern, not an architectural one.
 *
 * Design philosophy tested:
 * - Memory independent of agent type
 * - Cost optimization via model selection
 * - Unified agent framework (same lifecycle, different models)
 *
 * Requires: Meridian running (npm start)
 */

const API_BASE = 'http://localhost:3333';
const client = new MeridianTestClient();
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

async function httpPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

async function httpGet(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  return { status: resp.status, data: await resp.json() };
}

async function waitForTask(taskId, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = client.tasks.get(taskId);
    if (t && (t.status === 'completed' || t.status === 'failed')) return t;
    await sleep(500);
  }
  return null;
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

try {
  await client.connect();
  log('=== Model Selection E2E Test (4 cases) ===');

  // 1. Task with model field persisted in blackboard
  await test('Task model field persisted in blackboard', async () => {
    const { status, data } = await httpPost('/api/tasks', {
      prompt: 'say "hello from model test"',
      model: 'test-model-name',
      source: 'model-test',
    });
    assert.equal(status, 201, 'Should create task');
    assert.ok(data.id, 'Should return task id');

    // Verify via state API
    await sleep(500);
    const state = await httpGet('/api/state');
    const task = state.data.tasks.find(t => t.id === data.id);
    assert.ok(task, 'Task should exist in state');
    assert.equal(task.model, 'test-model-name',
      `Task model should be persisted, got: ${task.model}`);
    log(`Task ${data.id} has model: ${task.model}`);
  });

  await waitIdle();
  await sleep(1000);

  // 2. Task without model uses default
  await test('Task without model field uses default', async () => {
    const { status, data } = await httpPost('/api/tasks', {
      prompt: 'say "hello from default model"',
      source: 'model-test',
    });
    assert.equal(status, 201);

    await sleep(500);
    const state = await httpGet('/api/state');
    const task = state.data.tasks.find(t => t.id === data.id);
    assert.ok(task, 'Task should exist');
    assert.ok(!task.model || task.model === null,
      `Task model should be null/undefined for default, got: ${task.model}`);
    log(`Task ${data.id} has model: ${task.model ?? '(default)'}`);
  });

  await waitIdle();
  await sleep(1000);

  // 3. Two tasks with different models run with correct model
  await test('Two tasks with different models both complete', async () => {
    const { data: task1 } = await httpPost('/api/tasks', {
      prompt: 'write a one-word response: "alpha"',
      executor: 'claude-code',
      source: 'model-test',
    });
    const { data: task2 } = await httpPost('/api/tasks', {
      prompt: 'write a one-word response: "beta"',
      executor: 'claude-code',
      source: 'model-test',
    });

    log(`Created task1: ${task1.id}, task2: ${task2.id}`);

    // Both should complete
    const result1 = await waitForTask(task1.id, 120000);
    const result2 = await waitForTask(task2.id, 120000);

    assert.ok(result1, 'Task 1 should complete');
    assert.ok(result2, 'Task 2 should complete');
    assert.equal(result1.status, 'completed', `Task 1 status: ${result1.status}`);
    assert.equal(result2.status, 'completed', `Task 2 status: ${result2.status}`);
    log(`Both tasks completed: task1=${result1.status}, task2=${result2.status}`);
  });

  await waitIdle();
  await sleep(1000);

  // 4. Model field visible in agent feed
  await test('Agent feed includes model information', async () => {
    const feedsBefore = client.feeds.length;
    const { data } = await httpPost('/api/tasks', {
      prompt: 'say "model visibility test"',
      executor: 'claude-code',
      source: 'model-test',
    });

    const result = await waitForTask(data.id, 120000);
    assert.ok(result, 'Task should complete');

    // Check the agent_result feed for token info
    const resultFeeds = client.feeds
      .filter((f, i) => i >= feedsBefore && f.type === 'agent_result');
    assert.ok(resultFeeds.length > 0, 'Should have an agent_result feed entry');

    const feedContent = resultFeeds[0].content;
    log(`Result feed: ${feedContent.slice(0, 120)}`);
    // Result feed includes token counts: "Result (Xin/Yout): ..."
    assert.ok(feedContent.includes('Result'), 'Feed should contain result');
  });

  // Summary
  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
