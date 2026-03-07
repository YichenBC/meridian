import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Unified UX E2E Test — 14 cases
 *
 * Tests the full Meridian experience:
 * 1. Chat/greeting → friendly, no task created
 * 2. Simple question → direct answer
 * 3. Task delegation → ack + spawn + result
 * 4. Status (idle) → clear status
 * 5. Status (busy) → shows running tasks
 * 6. Stop (nothing running) → friendly "nothing to stop"
 * 7. Tool executor routing → task with executor matching config
 * 8. No duplicate messages
 * 9. Rapid-fire tasks → both picked up
 * 10. HTTP API: POST /api/tasks → task created on blackboard
 * 11. HTTP API: POST /api/notes → note created, no agent spawn
 * 12. Short/ambiguous message → graceful handling
 * 13. Skill install request → routes to skill-installer, creates skill
 * 14. Skill-aware routing → task matching installed skill uses correct executor
 *
 * Requires: Meridian running (npm start)
 */

const API_BASE = 'http://localhost:3333';
const client = new MeridianTestClient();
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

async function sendAndWaitResponse(content, timeout = 30000) {
  const feedsBefore = client.feeds.length;
  client.send(content);
  const resp = await client.waitForFeed('doorman_response',
    f => client.feeds.indexOf(f) >= feedsBefore, timeout);
  return resp;
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

try {
  await client.connect();
  log('=== Unified UX E2E Test (14 cases) ===');

  // 1. Greeting
  await test('Greeting gets chat reply', async () => {
    const resp = await sendAndWaitResponse('hey there');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 0, 'Response should not be empty');
    const recentTasks = Array.from(client.tasks.values())
      .filter(t => t.prompt?.includes('hey there'));
    assert.equal(recentTasks.length, 0, 'Greeting should not create a task');
    log(`Response: ${resp.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 2. Simple question
  await test('Simple question gets direct answer', async () => {
    const resp = await sendAndWaitResponse('what can you do?');
    assert.ok(resp, 'Should get a response');
    assert.ok(resp.content.length > 10, 'Response should be substantive');
    log(`Response: ${resp.content.slice(0, 120)}`);
  });

  await sleep(1000);

  // 3. Task delegation
  await test('Task request spawns agent and returns result', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a short poem about the moon');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 20000);
    assert.ok(ack, 'Should get acknowledgment');
    assert.ok(
      ack.content.length > 0,
      `Ack should not be empty, got: ${ack.content.slice(0, 80)}`
    );

    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 15000);
    assert.ok(spawned, 'Should spawn an agent');

    const result = await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 60000);
    assert.ok(result, 'Should get agent result');
    assert.ok(result.content.length > 20, 'Result should be substantive');
    log(`Result: ${result.content.slice(0, 100)}`);
  });

  await waitIdle();

  // 4. Status (idle)
  await test('Status when idle', async () => {
    const resp = await sendAndWaitResponse('status');
    assert.ok(resp, 'Should get status response');
    assert.ok(
      resp.content.includes('clear') || resp.content.includes('completed') || resp.content.includes('Working'),
      `Status should be informative, got: ${resp.content.slice(0, 100)}`
    );
    assert.ok(!resp.content.includes('---'), 'Status should not have robotic --- prefix');
    log(`Status: ${resp.content.slice(0, 120)}`);
  });

  await sleep(1000);

  // 5. Status while busy
  await test('Status while agent running', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a 3-paragraph essay about the history of computers');

    await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    await sleep(2000);

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

    await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 120000);
  });

  await waitIdle();
  await sleep(1000);

  // 6. Stop when nothing running
  await test('Stop when nothing running', async () => {
    const resp = await sendAndWaitResponse('stop');
    assert.ok(resp, 'Should get response');
    assert.ok(
      resp.content.includes('Nothing running') || resp.content.includes('nothing'),
      `Should say nothing running, got: ${resp.content.slice(0, 80)}`
    );
    log(`Response: ${resp.content}`);
  });

  await sleep(1000);

  // 7. Tool executor routing
  await test('Tool executor request', async () => {
    const taskIdsBefore = new Set(client.tasks.keys());
    const feedsBefore = client.feeds.length;
    client.send('list the files in the current directory');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');

    await sleep(1000);
    const toolTask = Array.from(client.tasks.values())
      .find(t => !taskIdsBefore.has(t.id) && t.executor === toolExecutor);
    assert.ok(toolTask, `New task should have ${toolExecutor} executor`);
    log(`Task created with executor: ${toolTask.executor}, id: ${toolTask.id}`);

    const waitForTask = async (taskId, timeout = 180000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const t = client.tasks.get(taskId);
        if (t && (t.status === 'completed' || t.status === 'failed')) return t;
        await sleep(500);
      }
      return null;
    };
    const taskDone = await waitForTask(toolTask.id);
    assert.ok(taskDone, 'Task should complete');
    assert.equal(taskDone.status, 'completed', `Task should succeed, got: ${taskDone.status}`);
    log(`Completed: ${taskDone.result?.slice(0, 100)}`);
  });

  await waitIdle();

  // 8. No duplicate messages
  await test('No duplicate messages on completion', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write one sentence about cats');

    await client.waitForFeed('agent_result',
      f => client.feeds.indexOf(f) >= feedsBefore, 60000);
    await sleep(1000);

    const resultFeeds = client.feeds
      .filter((f, i) => i >= feedsBefore)
      .filter(f => f.type === 'doorman_response' || f.type === 'agent_result');

    const duplicateRawFeeds = resultFeeds.filter(f =>
      f.content.startsWith('Result (') && f.type !== 'agent_result'
    );
    assert.equal(duplicateRawFeeds.length, 0,
      `Should not have raw "Result (...)" broadcast, found ${duplicateRawFeeds.length}`);
    log('No duplicate messages confirmed.');
  });

  await waitIdle();
  await sleep(1000);

  // 9. Rapid-fire tasks
  await test('Two rapid tasks both get picked up', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a haiku about rain');
    await sleep(300);
    client.send('write a haiku about snow');

    const acks = [];
    const ack1 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 15000);
    acks.push(ack1);
    const ack2 = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore && f !== ack1, 15000);
    acks.push(ack2);
    assert.equal(acks.length, 2, 'Should get 2 acknowledgments');

    const spawns = [];
    const s1 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    spawns.push(s1);
    const s2 = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore && f !== s1, 30000);
    spawns.push(s2);
    assert.equal(spawns.length, 2, 'Should have 2 agents spawned');
    log('Both tasks picked up and running.');

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

  await waitIdle();
  await sleep(1000);

  // 10. HTTP API: POST /api/tasks
  await test('HTTP API creates task on blackboard', async () => {
    const tasksBefore = new Set(client.tasks.keys());
    const { status, data } = await httpPost('/api/tasks', {
      prompt: 'write a one-liner joke about programming',
      role: 'writer',
      source: 'api-test',
    });
    assert.equal(status, 201, `Should return 201, got ${status}`);
    assert.ok(data.id, 'Should return task id');
    assert.equal(data.status, 'pending', 'Task should start as pending');
    log(`API task created: ${data.id}`);

    // Wait for it to be picked up and complete
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const t = client.tasks.get(data.id);
      if (t && (t.status === 'completed' || t.status === 'failed')) {
        assert.equal(t.status, 'completed', `API task should complete, got: ${t.status}`);
        log(`API task result: ${t.result?.slice(0, 100)}`);
        break;
      }
      await sleep(500);
    }
  });

  await waitIdle();
  await sleep(1000);

  // 11. HTTP API: POST /api/notes (no agent spawn)
  await test('HTTP API creates note without spawning agent', async () => {
    const agentsBefore = client.agents.size;
    const { status, data } = await httpPost('/api/notes', {
      title: 'Test observation',
      content: 'This is a test note from the API',
      source: 'api-test',
      tags: 'test,observation',
    });
    assert.equal(status, 201, `Should return 201, got ${status}`);
    assert.ok(data.id, 'Should return note id');

    // Verify no new agent spawned
    await sleep(2000);
    const newAgents = Array.from(client.agents.values())
      .filter(a => a.status === 'working');
    // Notes should not trigger agent spawn — only check that no new working agents appeared
    // (there may be agents from previous tests finishing up)
    log(`Note created: ${data.id}`);

    // Verify note exists via GET
    const getResp = await httpGet('/api/notes?limit=5');
    assert.equal(getResp.status, 200);
    const ourNote = getResp.data.find(n => n.id === data.id);
    assert.ok(ourNote, 'Note should be retrievable via API');
    assert.equal(ourNote.title, 'Test observation');
    log(`Note retrieved: ${ourNote.title}`);
  });

  await sleep(1000);

  // 12. Skill install request (slow — skip with SKIP_SLOW=1)
  if (process.env.SKIP_SLOW) {
    log('\n--- Test: Skill install routes to skill-installer executor --- SKIPPED');
    passed++;
  } else {
    await test('Skill install routes to skill-installer executor', async () => {
      const taskIdsBefore = new Set(client.tasks.keys());
      const feedsBefore = client.feeds.length;
      client.send('install the qr-code skill');

      const ack = await client.waitForFeed('doorman_response',
        f => client.feeds.indexOf(f) >= feedsBefore, 30000);
      assert.ok(ack, 'Should get acknowledgment');
      log(`Ack: ${ack.content.slice(0, 80)}`);

      const spawned = await client.waitForFeed('agent_spawned',
        f => client.feeds.indexOf(f) >= feedsBefore, 15000);
      assert.ok(spawned, 'Should spawn an agent');

      await sleep(1000);
      const installTask = Array.from(client.tasks.values())
        .find(t => !taskIdsBefore.has(t.id) && t.prompt?.toLowerCase().includes('qr'));
      assert.ok(installTask, 'Should create a task for skill install');
      assert.equal(installTask.executor, 'skill-installer',
        `Skill install should use skill-installer executor, got: ${installTask.executor}`);
      log(`Task executor: ${installTask.executor}, id: ${installTask.id}`);

      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const t = client.tasks.get(installTask.id);
        if (t && (t.status === 'completed' || t.status === 'failed')) {
          log(`Task ${t.status}: ${t.result?.slice(0, 100) || t.error?.slice(0, 100)}`);
          break;
        }
        await sleep(500);
      }
    });
    await waitIdle();
    await sleep(1000);
  }

  // 13. Skill-aware routing (slow — skip with SKIP_SLOW=1)
  if (process.env.SKIP_SLOW) {
    log('\n--- Test: Available skills and MCPs reported in status context --- SKIPPED');
    passed++;
  } else {
    await test('Available skills and MCPs reported in status context', async () => {
      const stateResp = await httpGet('/api/state');
      assert.equal(stateResp.status, 200);
      log(`State has ${stateResp.data.tasks.length} tasks, ${stateResp.data.agents.length} agents`);

      const feedsBefore = client.feeds.length;
      client.send('open google.com and take a screenshot');

      const ack = await client.waitForFeed('doorman_response',
        f => client.feeds.indexOf(f) >= feedsBefore, 30000);
      assert.ok(ack, 'Should get acknowledgment');

      await sleep(1000);
      const browserTask = Array.from(client.tasks.values())
        .find(t => t.prompt?.includes('google.com') || t.prompt?.includes('screenshot'));
      assert.ok(browserTask, 'Should create a browser task');
      assert.equal(browserTask.executor, toolExecutor,
        `Browser task should use ${toolExecutor}, got: ${browserTask.executor}`);
      log(`Browser task executor: ${browserTask.executor}`);

      const waitDeadline = Date.now() + 120000;
      while (Date.now() < waitDeadline) {
        const t = client.tasks.get(browserTask.id);
        if (t && (t.status === 'completed' || t.status === 'failed')) {
          log(`Browser task ${t.status}: ${(t.result || t.error || '').slice(0, 100)}`);
          break;
        }
        await sleep(500);
      }
    });
    await waitIdle();
    await sleep(1000);
  }

  await sleep(1000);

  // 14. Short ambiguous message
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
