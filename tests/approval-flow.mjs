import assert from 'node:assert/strict';
import { MeridianTestClient } from './lib/client.mjs';
import { sleep, log } from './lib/helpers.mjs';
import { getRuntimeConfig } from './lib/runtime.mjs';

/**
 * Approval Flow E2E Test — 3 cases
 *
 * Tests the full approval pipeline:
 * 1. Approval via HTTP API → agent resumes on approve
 * 2. Approval via WebSocket → agent resumes on approve
 * 3. Rejection → agent handles rejection
 *
 * Uses the constitutional permission system in 'supervised' mode
 * (asks for everything) to trigger approval requests.
 *
 * Requires: Meridian running with auditorMode='supervised' in meridian.json
 *           OR per-skill override for the test
 *
 * Note: If running in 'passthrough' mode, approvals won't be triggered
 * and this test will verify that behavior instead.
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
  log('=== Approval Flow E2E Test (3 cases) ===');

  // Check current auditor mode
  const stateResp = await httpGet('/api/state');
  assert.equal(stateResp.status, 200);
  log(`System state: ${stateResp.data.tasks.length} tasks, ${stateResp.data.agents.length} agents`);

  // 1. Approval creation and resolution via HTTP API
  await test('Approval created and resolved via HTTP API', async () => {
    // Create a task that will need approval (in supervised/constitutional mode)
    // Even if mode is passthrough, we test the HTTP approval endpoint directly
    const { status: createStatus, data: createData } = await httpPost('/api/tasks', {
      prompt: 'list the files in the current directory',
      executor: toolExecutor,
      source: 'approval-test',
    });
    assert.equal(createStatus, 201);
    log(`Task created: ${createData.id}`);

    // Wait for task to start
    const deadline = Date.now() + 30000;
    let taskStarted = false;
    while (Date.now() < deadline) {
      const task = client.tasks.get(createData.id);
      if (task && task.status !== 'pending') {
        taskStarted = true;
        break;
      }
      await sleep(500);
    }
    assert.ok(taskStarted, 'Task should start running');

    // Check for any pending approvals
    await sleep(3000);
    const state = await httpGet('/api/state');
    const pendingApprovals = state.data.approvals.filter(a => a.status === 'pending');

    if (pendingApprovals.length > 0) {
      log(`Found ${pendingApprovals.length} pending approval(s)`);
      const approval = pendingApprovals[0];
      log(`Approval: ${approval.description.slice(0, 100)}`);

      // Approve via HTTP API
      const { status: approveStatus } = await httpPost(`/api/approve/${approval.id}`, {
        action: 'approve',
      });
      assert.equal(approveStatus, 200, 'Approval should succeed');
      log(`Approved via HTTP API`);

      // Wait for task to complete after approval
      const taskDeadline = Date.now() + 120000;
      while (Date.now() < taskDeadline) {
        const task = client.tasks.get(createData.id);
        if (task && (task.status === 'completed' || task.status === 'failed')) {
          log(`Task ${task.status} after approval`);
          break;
        }
        await sleep(500);
      }
    } else {
      log(`No approvals triggered (likely passthrough mode) — task running directly`);
      // In passthrough mode, task should complete without approval
      const taskDeadline = Date.now() + 120000;
      while (Date.now() < taskDeadline) {
        const task = client.tasks.get(createData.id);
        if (task && (task.status === 'completed' || task.status === 'failed')) {
          assert.equal(task.status, 'completed', 'Task should complete in passthrough mode');
          log(`Task completed without approval (passthrough mode)`);
          break;
        }
        await sleep(500);
      }
    }
  });

  await waitIdle();
  await sleep(1000);

  // 2. Approval via WebSocket (user sends "approve" in chat)
  await test('Approval via chat message', async () => {
    const feedsBefore = client.feeds.length;
    client.send('write a haiku about approval');

    const ack = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 20000);
    assert.ok(ack, 'Should get acknowledgment');

    // Wait for possible approval request
    await sleep(5000);
    const state = await httpGet('/api/state');
    const pending = state.data.approvals.filter(a => a.status === 'pending');

    if (pending.length > 0) {
      // Approve via chat
      const chatFeedsBefore = client.feeds.length;
      client.send('approve');
      const approveResp = await client.waitForFeed('doorman_response',
        f => client.feeds.indexOf(f) >= chatFeedsBefore, 10000);
      assert.ok(approveResp, 'Should get approval confirmation');
      assert.ok(
        approveResp.content.includes('Approved') || approveResp.content.includes('approved'),
        `Should confirm approval, got: ${approveResp.content}`
      );
      log(`Approved via chat: ${approveResp.content}`);
    } else {
      log(`No approval needed (passthrough mode) — testing fast-path approve/reject`);

      // Test the fast-path approval handling directly (even without pending approval)
      // This exercises the regex patterns
      const chatFeedsBefore = client.feeds.length;
      client.send('approve');
      const resp = await client.waitForFeed('doorman_response',
        f => client.feeds.indexOf(f) >= chatFeedsBefore, 10000);
      assert.ok(resp, 'Should get a response to approve command');
      log(`Response to approve (no pending): ${resp.content.slice(0, 80)}`);
    }
  });

  await waitIdle();
  await sleep(1000);

  // 3. Rejection via chat
  await test('Rejection via chat message', async () => {
    // This tests the fast-path rejection pattern
    const feedsBefore = client.feeds.length;
    client.send('reject');
    const resp = await client.waitForFeed('doorman_response',
      f => client.feeds.indexOf(f) >= feedsBefore, 10000);
    assert.ok(resp, 'Should get a response to reject command');
    log(`Response to reject: ${resp.content.slice(0, 80)}`);
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
