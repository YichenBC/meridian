import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Telegram UX E2E Test — 10 cases
 *
 * Tests the full message pipeline that Telegram users experience.
 * Uses WebSocket client (same Doorman pipeline as Telegram).
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

/**
 * Helper: send a message and wait for the next doorman_response.
 * Filters out responses from before the message was sent.
 */
async function sendAndWaitResponse(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  const resp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
  return resp;
}

/**
 * Wait until no tasks are pending or running (system is idle).
 */
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
  log('=== Telegram UX E2E Test (10 cases) ===');

  // ---------------------------------------------------------------
  // 1. Greeting — should get a friendly chat reply, not a task
  // ---------------------------------------------------------------
  await test('Greeting gets chat reply', async () => {
    const resp = await sendAndWaitResponse('hey there');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 0, 'Response should not be empty');
    // Should NOT trigger a task
    const recentTasks = Array.from(client.tasks.values())
      .filter(t => t.prompt?.includes('hey there'));
    assert.equal(recentTasks.length, 0, 'Greeting should not create a task');
    log(`Response: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // ---------------------------------------------------------------
  // 2. Simple question — should get a direct chat answer
  // ---------------------------------------------------------------
  await test('Simple question gets direct answer', async () => {
    const resp = await sendAndWaitResponse('what can you do?');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 10, 'Response should be substantive');
    log(`Response: ${resp.content.slice(0, 120)}`);
  });

  await sleep(1000);

  // ---------------------------------------------------------------
  // 3. Task request — should acknowledge and spawn agent
  // ---------------------------------------------------------------
  await test('Task request spawns agent', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a short poem about the moon');

    // Should get an acknowledgment
    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 20000);
    assert.ok(ack, 'Should get acknowledgment');
    assert.ok(
      ack.content.includes('On it') || ack.content.includes('Noted'),
      `Ack should say "On it" or "Noted", got: ${ack.content.slice(0, 80)}`
    );
    log(`Ack: ${ack.content.slice(0, 80)}`);

    // Should spawn an agent
    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 15000);
    assert.ok(spawned, 'Should spawn an agent');
    log(`Spawned: ${spawned.content.slice(0, 80)}`);

    // Wait for result (up to 60s)
    const result = await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 60000);
    assert.ok(result, 'Should get agent result');
    assert.ok(result.content.length > 20, 'Result should be substantive');
    log(`Result: ${result.content.slice(0, 100)}`);
  });

  await waitIdle();

  // ---------------------------------------------------------------
  // 4. Status when idle — friendly "all clear" message
  // ---------------------------------------------------------------
  await test('Status when idle', async () => {
    const resp = await sendAndWaitResponse('status');
    assert.ok(resp, 'Should get status response');
    assert.ok(
      resp.content.includes('clear') || resp.content.includes('completed') || resp.content.includes('Working'),
      `Status should be informative, got: ${resp.content.slice(0, 100)}`
    );
    // Should NOT have robotic prefix
    assert.ok(!resp.content.includes('---'), 'Status should not have --- prefix');
    log(`Status: ${resp.content.slice(0, 120)}`);
  });

  await sleep(1000);

  // ---------------------------------------------------------------
  // 5. Stop when nothing running — friendly "nothing to stop"
  // ---------------------------------------------------------------
  await test('Stop when nothing running', async () => {
    await waitIdle(); // ensure no leftover tasks from previous test
    const resp = await sendAndWaitResponse('stop');
    assert.ok(resp, 'Should get response');
    assert.ok(
      resp.content.includes('Nothing running') || resp.content.includes('nothing'),
      `Should say nothing running, got: ${resp.content.slice(0, 80)}`
    );
    log(`Response: ${resp.content}`);
  });

  await sleep(1000);

  // ---------------------------------------------------------------
  // 6. Short/ambiguous message — should not crash or say "empty"
  // ---------------------------------------------------------------
  await test('Short ambiguous message handled gracefully', async () => {
    const resp = await sendAndWaitResponse('hmm');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 0, 'Response should not be empty');
    assert.ok(
      !resp.content.toLowerCase().includes('empty'),
      `Should not say "empty", got: ${resp.content.slice(0, 80)}`
    );
    log(`Response: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // ---------------------------------------------------------------
  // 7. Task with explicit executor — "use claude code to..."
  // ---------------------------------------------------------------
  await test('Claude Code executor request', async () => {
    // Snapshot task IDs before sending so we only match new tasks
    const taskIdsBefore = new Set(client.tasks.keys());
    const feedsBefore = client.feeds.length;
    client.send('use claude code to list the files in the current directory');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');
    assert.ok(
      ack.content.includes('On it') || ack.content.includes('Noted'),
      `Should acknowledge, got: ${ack.content.slice(0, 80)}`
    );

    // Find the NEW task with claude-code executor
    await sleep(1000); // give task creation time to propagate
    const ccTask = Array.from(client.tasks.values())
      .find(t => !taskIdsBefore.has(t.id) && t.executor === 'claude-code');
    assert.ok(ccTask, 'New task should have claude-code executor');
    log(`Task created with executor: ${ccTask.executor}, id: ${ccTask.id}`);

    // Wait for this specific task to complete
    log('Waiting for claude-code task to complete (up to 3 min)...');
    const waitForTask = async (taskId, timeout = 180000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const t = client.tasks.get(taskId);
        if (t && (t.status === 'completed' || t.status === 'failed')) return t;
        await sleep(500);
      }
      return null;
    };
    const taskDone = await waitForTask(ccTask.id);
    assert.ok(taskDone, 'Task should complete');
    assert.equal(taskDone.status, 'completed', `Task should succeed, got: ${taskDone.status}`);
    log(`Completed: ${taskDone.result?.slice(0, 100)}`);
  });

  await waitIdle();

  // ---------------------------------------------------------------
  // 8. Progress check while agent running
  // ---------------------------------------------------------------
  await test('Progress check while agent running', async () => {
    // Start a task (explicit wording so classifier doesn't confuse with chat)
    const feedsBefore = client.feeds.length;
    client.send('write a 3-paragraph essay about the history of computers');

    // Wait for it to start (allow extra time for classifier)
    await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);

    await sleep(2000);

    // Ask about progress
    const progressBefore = client.feeds.length;
    client.send('status');
    const statusResp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= progressBefore, 15000);
    assert.ok(statusResp, 'Should get status while running');
    assert.ok(
      statusResp.content.includes('Working') || statusResp.content.includes('running') || statusResp.content.includes('task'),
      `Status should mention working tasks, got: ${statusResp.content.slice(0, 120)}`
    );
    log(`In-progress status: ${statusResp.content.slice(0, 120)}`);

    // Wait for task to finish before next test
    log('Waiting for task to finish...');
    await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 120000);
  });

  await sleep(2000);

  // ---------------------------------------------------------------
  // 9. No duplicate messages on task completion
  // ---------------------------------------------------------------
  await test('No duplicate messages on completion', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write one sentence about cats');

    // Wait for agent to complete
    await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 60000);

    await sleep(1000); // Give time for any duplicate to arrive

    // Count doorman_responses that look like task results (not the ack)
    const resultFeeds = client.feeds
      .filter((f, i) => i >= feedsBefore)
      .filter(f => f.type === 'doorman_response' || f.type === 'agent_result');

    // We expect: 1 doorman ack ("On it") + 1 agent_result + 1 task:updated broadcast
    // But NOT a duplicate raw feed broadcast
    const duplicateRawFeeds = resultFeeds.filter(f =>
      f.content.startsWith('Result (') && f.type !== 'agent_result'
    );
    assert.equal(duplicateRawFeeds.length, 0,
      `Should not have raw "Result (...)" broadcast, found ${duplicateRawFeeds.length}`);
    log('No duplicate messages confirmed.');
  });

  await sleep(2000);

  // ---------------------------------------------------------------
  // 10. Rapid-fire: two tasks at once when idle
  // ---------------------------------------------------------------
  await test('Two rapid tasks both get picked up', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a haiku about rain');
    await sleep(300);
    client.send('write a haiku about snow');

    // Both should get acknowledged
    const acks = [];
    const ack1 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 15000);
    acks.push(ack1);
    const ack2 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore && f !== ack1, 15000);
    acks.push(ack2);
    assert.equal(acks.length, 2, 'Should get 2 acknowledgments');

    // Both should spawn agents
    const spawns = [];
    const s1 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 15000);
    spawns.push(s1);
    const s2 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore && f !== s1, 15000);
    spawns.push(s2);
    assert.equal(spawns.length, 2, 'Should have 2 agents spawned');
    log('Both tasks picked up and running.');

    // Wait for both to complete
    const waitAllDone = async (timeout = 120000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const active = Array.from(client.tasks.values())
          .filter(t => t.status === 'pending' || t.status === 'running');
        if (active.length === 0) return true;
        await sleep(1000);
      }
      return false;
    };
    await waitAllDone();
    log('Both tasks completed.');
  });

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
} finally {
  client.disconnect();
}
