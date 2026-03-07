import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Doorman Routing Test — 8 cases
 *
 * Tests that the Doorman correctly routes messages:
 * - Knowledge questions → direct answer (no task)
 * - Conversational mentions of action words → direct answer (no task)
 * - Real action requests → delegate to agent
 * - Model selection → task created with specified model
 *
 * These test the improved Doorman prompt few-shot examples and verify
 * the NEEDS_ACTION regex doesn't cause false positives.
 *
 * Requires: Meridian running (npm start)
 */

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

async function sendAndWaitResponse(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  const resp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
  return resp;
}

function getNewTasks(tasksBefore) {
  return Array.from(client.tasks.values())
    .filter(t => !tasksBefore.has(t.id));
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
  log('=== Doorman Routing Test (8 cases) ===');

  // 1. Knowledge question with action word — should NOT delegate
  await test('Knowledge question "what does deploy mean" → direct answer', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const resp = await sendAndWaitResponse('what does deploy mean?');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 10, 'Should give a substantive explanation');
    await sleep(2000);
    const newTasks = getNewTasks(tasksBefore);
    assert.equal(newTasks.length, 0,
      `Should NOT create a task for a knowledge question, but created ${newTasks.length}`);
    log(`Direct answer: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 2. Conversational mention of "test" — should NOT delegate
  await test('Conversational "I ran a test yesterday" → direct answer', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const resp = await sendAndWaitResponse('I ran a test yesterday and it passed');
    assert.ok(resp, 'Should get a response');
    await sleep(2000);
    const newTasks = getNewTasks(tasksBefore);
    assert.equal(newTasks.length, 0,
      `Should NOT create a task for conversation, but created ${newTasks.length}`);
    log(`Direct answer: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 3. Conversational "check" — should NOT delegate
  await test('Conversational "let me check with you" → direct answer', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const resp = await sendAndWaitResponse('let me check with you on something — do you support multiple models?');
    assert.ok(resp, 'Should get a response');
    await sleep(2000);
    const newTasks = getNewTasks(tasksBefore);
    assert.equal(newTasks.length, 0,
      `Should NOT create a task for conversational check, but created ${newTasks.length}`);
    log(`Direct answer: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 4. Real action request — SHOULD delegate
  await test('Real action "check if port 3333 is in use" → delegates', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const feedsBefore = client.feeds.length;
    client.send('check if port 3333 is in use on this machine');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');

    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned, 'Should spawn an agent for real verification');
    log(`Delegated correctly, agent spawned`);
  });

  await waitIdle();
  await sleep(1000);

  // 5. Explain-style question — should NOT delegate
  await test('Explain question "explain what a blackboard pattern is" → direct answer', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const resp = await sendAndWaitResponse('can you explain what a blackboard pattern is in software architecture?');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 20, 'Should give a substantive explanation');
    await sleep(2000);
    const newTasks = getNewTasks(tasksBefore);
    assert.equal(newTasks.length, 0,
      `Should NOT delegate an explanation question, but created ${newTasks.length}`);
    log(`Direct answer: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 6. Real file operation — SHOULD delegate
  await test('File operation "read package.json" → delegates', async () => {
    const feedsBefore = client.feeds.length;
    client.send('read the contents of package.json');

    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned, 'Should spawn an agent for file reading');
    log(`Delegated correctly, agent spawned`);
  });

  await waitIdle();
  await sleep(1000);

  // 7. Model selection via HTTP API
  await test('HTTP API task with model override', async () => {
    const resp = await fetch('http://localhost:3333/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'write a one-liner joke',
        model: 'claude-haiku-4-5-20251001',
        source: 'routing-test',
      }),
    });
    assert.equal(resp.status, 201, 'Should create task');
    const data = await resp.json();

    // Verify the task has the model field
    await sleep(1000);
    const task = client.tasks.get(data.id);
    assert.ok(task, 'Task should appear in state');
    assert.equal(task.model, 'claude-haiku-4-5-20251001',
      `Task should have model override, got: ${task.model}`);
    log(`Task created with model: ${task.model}`);
  });

  await waitIdle();
  await sleep(1000);

  // 8. Mixed — action word in question context about the system
  await test('System question "how do you run tasks?" → direct answer', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const resp = await sendAndWaitResponse('how do you run tasks internally?');
    assert.ok(resp, 'Should get a response');
    await sleep(2000);
    const newTasks = getNewTasks(tasksBefore);
    assert.equal(newTasks.length, 0,
      `Should NOT delegate a self-knowledge question, but created ${newTasks.length}`);
    log(`Direct answer: ${resp.content.slice(0, 100)}`);
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
