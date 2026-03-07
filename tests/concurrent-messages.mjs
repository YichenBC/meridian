import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Concurrent Messages E2E Test — 4 cases
 *
 * Tests that the Doorman handles multiple simultaneous user messages
 * gracefully while agents are running. Validates the async human-agent
 * interaction principle: "user is NEVER waiting."
 *
 * Design philosophy tested:
 * - Continuous feedback: user always gets a response
 * - Async interaction: Doorman responds while specialists work
 * - Resource management: tasks queue properly under load
 * - No message loss: every message gets acknowledged
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

async function waitIdle(timeout = 180000) {
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
  log('=== Concurrent Messages E2E Test (4 cases) ===');

  // 1. Chat during agent execution — user gets immediate response
  await test('Chat while agent is running gets immediate response', async () => {
    // Start a long-running task
    const feedsBefore = client.feeds.length;
    client.send('write a 5-paragraph essay about the history of programming languages');

    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned, 'Agent should spawn');

    // While agent is running, send a chat message
    await sleep(2000);
    const chatFeedsBefore = client.feeds.length;
    client.send('hey, how are you?');

    const chatResp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= chatFeedsBefore, 30000);
    assert.ok(chatResp, 'Should get chat response while agent is working');
    assert.ok(chatResp.content.length > 0, 'Chat response should not be empty');
    log(`Got response while agent working: ${chatResp.content.slice(0, 80)}`);

    // Agent should still complete its task
    const result = await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 120000);
    assert.ok(result, 'Agent should complete its task');
    log(`Agent completed while we chatted`);
  });

  await waitIdle();
  await sleep(1000);

  // 2. Status check during execution
  await test('Status check during agent execution shows running task', async () => {
    const feedsBefore = client.feeds.length;
    client.send('analyze the project structure and list all source files');

    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned, 'Agent should spawn');

    // Check status while running
    await sleep(3000);
    const statusFeedsBefore = client.feeds.length;
    client.send('status');

    const statusResp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= statusFeedsBefore, 15000);
    assert.ok(statusResp, 'Should get status');
    assert.ok(
      statusResp.content.includes('Working') || statusResp.content.includes('running') ||
      statusResp.content.includes('task') || statusResp.content.includes('1'),
      `Status should mention active work, got: ${statusResp.content.slice(0, 120)}`
    );
    log(`Status during execution: ${statusResp.content.slice(0, 120)}`);

    // Wait for completion
    await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 120000);
  });

  await waitIdle();
  await sleep(1000);

  // 3. Multiple rapid messages — all get responses
  await test('3 rapid messages all get responses', async () => {
    const feedsBefore = client.feeds.length;

    // Send 3 messages rapidly
    client.send('hello');
    await sleep(200);
    client.send('what time is it?');
    await sleep(200);
    client.send('tell me a joke');

    // Wait for 3 doorman responses
    const responses = [];
    const deadline = Date.now() + 60000;
    while (responses.length < 3 && Date.now() < deadline) {
      const newResponses = client.feeds
        .filter((f, i) => i >= feedsBefore && f.type === 'doorman_response')
        .filter(f => !responses.includes(f));
      for (const r of newResponses) {
        responses.push(r);
      }
      if (responses.length < 3) await sleep(500);
    }

    assert.ok(responses.length >= 3,
      `Should get 3 responses, got ${responses.length}`);
    log(`All ${responses.length} rapid messages got responses`);
    for (const r of responses) {
      log(`  → ${r.content.slice(0, 60)}`);
    }
  });

  await waitIdle();
  await sleep(1000);

  // 4. New task while other task is running
  await test('New task queues/spawns while another is running', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a detailed comparison of Python and JavaScript');

    const spawned1 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned1, 'First agent should spawn');

    // Send second task while first is running
    await sleep(2000);
    const feedsBefore2 = client.feeds.length;
    client.send('write a haiku about concurrency');

    const ack2 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore2, 30000);
    assert.ok(ack2, 'Second task should be acknowledged');

    // Second task should either spawn or queue depending on slots
    const spawned2 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore2, 30000);
    if (spawned2) {
      log(`Second task spawned in parallel (slots available)`);
    } else {
      log(`Second task queued (slots full) — will drain after first completes`);
    }

    // Both should eventually complete
    const waitAllDone = async (timeout = 180000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const active = Array.from(client.tasks.values())
          .filter(t => t.status === 'pending' || t.status === 'running');
        if (active.length === 0) return true;
        await sleep(1000);
      }
      return false;
    };
    const allDone = await waitAllDone();
    assert.ok(allDone, 'Both tasks should eventually complete');
    log(`Both tasks completed`);
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
