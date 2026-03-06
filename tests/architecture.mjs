import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';

/**
 * Architecture E2E Tests — validates core design philosophy:
 *
 * 1. Doorman is a Claude Code CLI agent (knows its model, has self-awareness)
 * 2. Doorman has session memory (conversation continuity via --resume)
 * 3. Blackboard is the coordination hub (tasks, feeds visible via state)
 * 4. System introspection goes through blackboard as a task
 * 5. Reactive spawning (HTTP API tasks auto-picked up by Runner)
 * 6. Notes are informational (no agent spawn)
 * 7. No hardcoded roles (executor-based routing only)
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
  log('=== Architecture E2E Tests ===');

  // 1. Doorman self-awareness — Claude Code CLI knows its model
  await test('Doorman knows its own model (Claude Code self-awareness)', async () => {
    const resp = await sendAndWaitResponse('what model are you? answer concisely');
    assert.ok(resp, 'Should get response');
    const content = resp.content.toLowerCase();
    // Claude Code CLI knows it runs Claude — should mention claude/sonnet/opus/haiku
    assert.ok(
      content.includes('claude') || content.includes('sonnet') || content.includes('opus') || content.includes('haiku'),
      `Should mention Claude model, got: ${resp.content.slice(0, 150)}`
    );
    log(`Model response: ${resp.content.slice(0, 150)}`);
  });

  await sleep(1000);

  // 2. Doorman session memory — remembers previous messages via --resume
  await test('Doorman has session memory (conversation continuity)', async () => {
    // First message: establish a fact
    const resp1 = await sendAndWaitResponse('my favorite color is purple, remember that');
    assert.ok(resp1, 'Should get first response');
    log(`First: ${resp1.content.slice(0, 100)}`);

    await sleep(1000);

    // Second message: ask about the fact
    const resp2 = await sendAndWaitResponse('what is my favorite color?');
    assert.ok(resp2, 'Should get second response');
    assert.ok(
      resp2.content.toLowerCase().includes('purple'),
      `Should remember purple, got: ${resp2.content.slice(0, 150)}`
    );
    log(`Memory: ${resp2.content.slice(0, 100)}`);
  });

  await sleep(1000);

  // 3. Blackboard as coordination hub — state visible via API
  await test('Blackboard state accessible via HTTP API', async () => {
    const stateResp = await httpGet('/api/state');
    assert.equal(stateResp.status, 200);
    assert.ok(Array.isArray(stateResp.data.tasks), 'State should have tasks array');
    assert.ok(Array.isArray(stateResp.data.agents), 'State should have agents array');
    assert.ok(Array.isArray(stateResp.data.feeds), 'State should have feeds array');
    assert.ok(Array.isArray(stateResp.data.notes), 'State should have notes array');
    log(`State: ${stateResp.data.tasks.length} tasks, ${stateResp.data.feeds.length} feeds`);
  });

  await sleep(1000);

  // 4. System introspection via task — not hardcoded in Doorman
  await test('System check creates claude-code task (not hardcoded answer)', async () => {
    const taskIdsBefore = new Set(client.tasks.keys());
    const feedsBefore = client.feeds.length;
    client.send('check the meridian database and tell me how many tables it has');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(ack, 'Should get acknowledgment');

    // Should spawn a claude-code task (system introspection needs tools)
    await sleep(2000);
    const sysTask = Array.from(client.tasks.values())
      .find(t => !taskIdsBefore.has(t.id) && (t.executor === 'claude-code'));
    assert.ok(sysTask, 'System check should create a claude-code task');
    log(`Task created: executor=${sysTask.executor}, prompt=${sysTask.prompt.slice(0, 80)}`);

    // Wait for completion
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const t = client.tasks.get(sysTask.id);
      if (t && (t.status === 'completed' || t.status === 'failed')) {
        log(`Result: ${(t.result || t.error || '').slice(0, 100)}`);
        break;
      }
      await sleep(500);
    }
  });

  await waitIdle();
  await sleep(1000);

  // 5. Reactive spawning — HTTP API task auto-picked up by Runner
  await test('HTTP API task auto-spawned by reactive Runner', async () => {
    const feedsBefore = client.feeds.length;
    const { status, data } = await httpPost('/api/tasks', {
      prompt: 'write one sentence about the ocean',
      source: 'api-test',
    });
    assert.equal(status, 201);
    assert.equal(data.status, 'pending');
    log(`Task posted via API: ${data.id}`);

    // Runner should auto-pick it up (reactive blackboard)
    const spawned = await client.waitForFeed('agent_spawned',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);
    assert.ok(spawned, 'Runner should auto-spawn for API-posted task');
    log('Runner reactively picked up API task');

    // Wait for completion
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const t = client.tasks.get(data.id);
      if (t && (t.status === 'completed' || t.status === 'failed')) {
        assert.equal(t.status, 'completed');
        log(`Completed: ${t.result?.slice(0, 80)}`);
        break;
      }
      await sleep(500);
    }
  });

  await waitIdle();
  await sleep(1000);

  // 6. Notes don't trigger agent spawn
  await test('Notes are informational — no agent spawn', async () => {
    const agentCountBefore = Array.from(client.agents.values())
      .filter(a => a.status === 'working').length;

    const { status, data } = await httpPost('/api/notes', {
      title: 'Architecture test note',
      content: 'This note should not trigger any agent spawn',
      source: 'test',
      tags: 'test,architecture',
    });
    assert.equal(status, 201);
    assert.ok(data.id);

    // Wait and verify no new agents appeared
    await sleep(3000);
    const agentCountAfter = Array.from(client.agents.values())
      .filter(a => a.status === 'working').length;
    assert.ok(agentCountAfter <= agentCountBefore,
      `No new agents should spawn for notes (before=${agentCountBefore}, after=${agentCountAfter})`);

    // Verify note exists
    const notes = await httpGet('/api/notes?tag=architecture');
    const ourNote = notes.data.find(n => n.id === data.id);
    assert.ok(ourNote, 'Note should be queryable by tag');
    log(`Note stored: "${ourNote.title}" with tags "${ourNote.tags}"`);
  });

  await sleep(1000);

  // 7. No hardcoded roles — executor-based routing
  await test('Tasks use executor-based routing, not hardcoded roles', async () => {
    const taskIdsBefore = new Set(client.tasks.keys());
    const feedsBefore = client.feeds.length;

    // Send a task that needs tools
    client.send('read the package.json file and tell me the project name');
    await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 30000);

    await sleep(2000);
    const toolTask = Array.from(client.tasks.values())
      .find(t => !taskIdsBefore.has(t.id));

    if (toolTask) {
      // Should use executor routing, not role-based
      assert.ok(
        toolTask.executor === 'claude-code',
        `File-reading task should route to claude-code executor, got: ${toolTask.executor}`
      );
      assert.equal(toolTask.role, 'general',
        `Role should be generic "general", not a hardcoded role like "coder". Got: ${toolTask.role}`);
      log(`Task: executor=${toolTask.executor}, role=${toolTask.role}`);
    }

    await waitIdle();
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
